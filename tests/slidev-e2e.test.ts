import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuild, slidevBin } from '../src/commands/slidev.js'
import {
  deckFrontmatter,
  findForbiddenBuildRefs,
  findOutsideImports,
  PLANTUML_DISABLED_SERVER,
} from '../src/lib/slidev.js'

/**
 * Real Slidev builds against the committed example workspace. Runs only when its dependencies are
 * installed (`npm ci --prefix examples/faktura`, done by the CI `deck` job); skipped otherwise.
 * Each policy (PlantUML server, system fonts, data: favicon, no browser exporter, no MCP server) is
 * checked with a negative control that shows what Slidev does without it.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.join(repoRoot, 'examples', 'faktura')
const installed = existsSync(path.join(workspace, 'node_modules', '@slidev', 'cli', 'package.json'))

const OFFLINE = deckFrontmatter({ title: 'Probe', lang: 'en' })
const PLANTUML_BLOCK = '```plantuml\n@startuml\nAlice -> Bob : diagram-source\n@enduml\n```\n'

const scratch: string[] = []
function cleanup(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
}
afterAll(cleanup)
// Probe decks contain PlantUML; one left by an interrupted run would fail `course build`.
beforeAll(() => {
  if (!installed) return
  for (const entry of readdirSync(workspace)) {
    if (entry.startsWith('.e2e-probe-')) {
      rmSync(path.join(workspace, entry), { recursive: true, force: true })
    }
  }
})

function allText(dir: string): string {
  let out = ''
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(html|js|css)$/.test(entry.name)) {
      out += readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
    }
  }
  return out
}

/** Write a probe deck inside the workspace (so Slidev resolves the theme); returns its path. */
function probeDeck(headmatter: string, body: string): string {
  const dir = mkdtempSync(path.join(workspace, '.e2e-probe-'))
  scratch.push(dir)
  const entry = path.join(dir, 'slides.md')
  writeFileSync(entry, `${headmatter}\n\n# Probe\n\n${body}`)
  return entry
}

/** Build a probe deck directly with Slidev (bypassing the course guard); returns the out dir. */
function buildProbe(headmatter: string, body = ''): string {
  const entry = probeDeck(headmatter, body)
  const out = path.join(path.dirname(entry), 'out')
  execFileSync(process.execPath, [slidevBin(workspace), 'build', entry, '--out', out], {
    cwd: workspace,
    stdio: 'pipe',
  })
  return out
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Start `slidev <entry>` (dev server), fetch some paths from it, then stop it. Returns the bodies.
 * (Slidev 52's startup banner always lists /export/: it tests the JSON-stringified flag, which is
 * truthy even for "false". The client gets the real value through Vite's /@vite/env defines.)
 */
async function devFetch(
  entry: string,
  paths: Array<string | [string, RequestInit]>,
): Promise<string[]> {
  const port = await freePort()
  const child = spawn(process.execPath, [slidevBin(workspace), entry, '--port', String(port)], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dev server did not start:\n${out}`)), 90_000)
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('slides overview')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => reject(new Error(`dev server exited (${code}):\n${out}`)))
    })
    const bodies: string[] = []
    for (const p of paths) {
      const [url, init] = typeof p === 'string' ? [p, undefined] : p
      bodies.push(await (await fetch(`http://localhost:${port}${url}`, init)).text())
    }
    return bodies
  } finally {
    child.kill()
  }
}

const flag = (env: string, name: string) => env.match(new RegExp(`"${name}":\\s*(true|false)`))?.[1]

/** Headmatter with one policy entry removed (for negative controls). */
const without = (pattern: RegExp) => OFFLINE.replace(pattern, '')

describe.skipIf(!installed)('real Slidev (examples/faktura)', () => {
  it('snippet imports: Slidev inlines any workspace file, so the guard refuses secrets (negative control)', () => {
    try {
      // `@/` is the deck's own directory; a benign snippet there is inlined and not flagged.
      const entry = probeDeck(
        OFFLINE,
        '<<< @/benign.txt text\n\n<<< ./dummy.env text\n\n<<< ./diagram.txt plantuml\n',
      )
      const dir = path.dirname(entry)
      writeFileSync(path.join(dir, 'benign.txt'), 'benign-snippet-marker\n')
      writeFileSync(path.join(dir, 'dummy.env'), 'E2E_DUMMY_SECRET=dummy-env-marker\n')
      writeFileSync(path.join(dir, 'diagram.txt'), '@startuml\nA -> B\n@enduml\n')
      const out = path.join(dir, 'out')
      // Without the guard Slidev inlines the env file, and a PlantUML snippet becomes a component.
      execFileSync(process.execPath, [slidevBin(workspace), 'build', entry, '--out', out], {
        cwd: workspace,
        stdio: 'pipe',
      })
      const text = allText(out)
      expect(text).toContain('benign-snippet-marker')
      expect(text).toContain('dummy-env-marker')
      // The guard sees both problems, and not the benign snippet.
      const probe = path.relative(workspace, entry).split(path.sep).join('/')
      expect(findOutsideImports(workspace)).toEqual([
        `${probe} -> <<< ./diagram.txt`,
        `${probe} -> <<< ./dummy.env`,
      ])
    } finally {
      cleanup()
    }
  }, 180_000)

  it('asset paths: Slidev bundles any file a local path points to, so the guard refuses secrets (negative control)', () => {
    // Slidev only refuses paths outside its Vite root, and only for Markdown/HTML images: CSS url()
    // and image:/background: frontmatter reach any file, and ?raw puts a file's text into the bundle.
    // The files next to the deck are > 4 KiB so Vite emits them as files; the outside one is inlined.
    const marker = 'asset-leak-marker'
    const big = `${marker}\n${'x'.repeat(5000)}\n`
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'course-kit-asset-'))
    const outsideFile = path.join(outsideDir, 'outside.txt')
    // Small files are inlined as base64 data URIs: look for the marker's base64 at every alignment.
    const needles = [0, 1, 2].map((pad) =>
      Buffer.from(`${'x'.repeat(pad)}${marker}`)
        .toString('base64')
        .slice(4, 12),
    )
    const bundleHasMarker = (out: string): boolean =>
      readdirSync(out, { withFileTypes: true, recursive: true }).some((e) => {
        if (!e.isFile()) return false
        const text = readFileSync(path.join(e.parentPath, e.name)).toString('latin1')
        return text.includes(marker) || needles.some((n) => text.includes(n))
      })
    const cases: Array<[string, string]> = [
      ['?raw', '![](./dummy.env?raw)\n'],
      ['url() of an env file', '<style>.x { background: url(./dummy.env) }</style>\n'],
      ['image: frontmatter', '\n---\nlayout: image\nimage: ./secret.txt\n---\n\n# s\n'],
      ['url() outside the workspace', `<style>.x { background: url(${outsideFile}) }</style>\n`],
    ]
    for (const [what, body] of cases) {
      // cleanup() below removes outsideDir after each case, so it is recreated here.
      mkdirSync(outsideDir, { recursive: true })
      scratch.push(outsideDir)
      writeFileSync(outsideFile, `${marker}\n`)
      try {
        const entry = probeDeck(OFFLINE, body)
        const dir = path.dirname(entry)
        writeFileSync(path.join(dir, 'dummy.env'), big)
        writeFileSync(path.join(dir, 'secret.txt'), big)
        writeFileSync(path.join(dir, 'ok.png'), 'x')
        // The output goes outside the workspace: built .html/.css would be scanned by the guard.
        const out = path.join(outsideDir, 'out')
        // Without the guard the real build contains the secret ...
        execFileSync(process.execPath, [slidevBin(workspace), 'build', entry, '--out', out], {
          cwd: workspace,
          stdio: 'pipe',
        })
        expect(bundleHasMarker(out), what).toBe(true)
        // ... and the guard sees the reference, but not a harmless image next to the deck.
        const probe = path.relative(workspace, entry).split(path.sep).join('/')
        expect(findOutsideImports(workspace), what).toHaveLength(1)
        expect(findOutsideImports(workspace)[0], what).toMatch(new RegExp(`^${probe} -> asset `))
      } finally {
        cleanup()
      }
    }
  }, 300_000)

  it('PlantUML: the data: server keeps diagrams off plantuml.com; the scan catches the default', () => {
    try {
      const safe = buildProbe(OFFLINE, PLANTUML_BLOCK)
      expect(findForbiddenBuildRefs(safe)).toEqual([])
      expect(allText(safe)).toContain(PLANTUML_DISABLED_SERVER)

      const leaky = buildProbe(without(/^plantUmlServer:.*\n/m), PLANTUML_BLOCK)
      expect(findForbiddenBuildRefs(leaky).map((r) => r.what)).toContain('PlantUML server')
    } finally {
      // The probes contain PlantUML blocks; the workspace guard must not see them afterwards.
      cleanup()
    }
  }, 180_000)

  it('fonts: provider "none" means no web-font CDN in the output; the default loads Google Fonts', () => {
    try {
      const offline = buildProbe(OFFLINE)
      expect(findForbiddenBuildRefs(offline)).toEqual([])
      expect(allText(offline)).toMatch(/system-ui/)

      const online = buildProbe(without(/^fonts:\n(?: {2}.*\n)+/m))
      expect(allText(online)).toContain('fonts.googleapis.com')
      expect(findForbiddenBuildRefs(online).map((r) => r.what)).toContain('web fonts')
    } finally {
      cleanup()
    }
  }, 180_000)

  it('favicon: the data: URL means no CDN request; the default favicon is on cdn.jsdelivr.net', () => {
    try {
      const offline = buildProbe(OFFLINE)
      expect(readFileSync(path.join(offline, 'index.html'), 'utf8')).toContain(
        '<link rel="icon" href="data:,">',
      )
      expect(findForbiddenBuildRefs(offline)).toEqual([])

      const online = buildProbe(without(/^favicon:.*\n/m))
      expect(readFileSync(path.join(online, 'index.html'), 'utf8')).toContain('cdn.jsdelivr.net')
      expect(findForbiddenBuildRefs(online).map((r) => r.what)).toContain('CDN favicon')
    } finally {
      cleanup()
    }
  }, 180_000)

  it('dev server: no /export or /print page, web fonts or CDN favicon; the defaults enable all', async () => {
    try {
      const [env, page] = await devFetch(probeDeck(OFFLINE, ''), ['/@vite/env', '/'])
      expect(flag(env!, '__SLIDEV_FEATURE_BROWSER_EXPORTER__')).toBe('false')
      expect(flag(env!, '__SLIDEV_FEATURE_PRINT__')).toBe('false')
      expect(page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/)

      const defaults = OFFLINE.replace(/^browserExporter:.*\n/m, '')
        .replace(/^fonts:\n(?: {2}.*\n)+/m, '')
        .replace(/^favicon:.*\n/m, '')
      const [envOn, pageOn] = await devFetch(probeDeck(defaults, ''), ['/@vite/env', '/'])
      expect(flag(envOn!, '__SLIDEV_FEATURE_BROWSER_EXPORTER__')).toBe('true')
      expect(pageOn).toContain('fonts.googleapis.com')
      expect(pageOn).toContain('cdn.jsdelivr.net')
    } finally {
      cleanup()
    }
  }, 240_000)

  it('dev server: `mcp: false` turns off the deck-editing /__mcp endpoint; the default serves it', async () => {
    // A same-origin JSON-RPC call, like one from another page on localhost would make.
    const initialize: [string, RequestInit] = [
      '/__mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'e2e', version: '0' },
          },
        }),
      },
    ]
    try {
      const [off] = await devFetch(probeDeck(OFFLINE, ''), [initialize])
      expect(off).toContain('The Slidev MCP server is disabled')

      const [on] = await devFetch(probeDeck(without(/^mcp:.*\n/m), ''), [initialize])
      expect(on).toContain('serverInfo')
    } finally {
      cleanup()
    }
  }, 240_000)

  it('`course build` builds the faktura lesson offline, with its Mermaid diagram', () => {
    const result = runBuild({ cwd: workspace })
    expect(result.decks.map((d) => `${d.lessonId}/${d.lang}`)).toEqual([
      '01-architecture/en',
      '01-architecture/pl',
    ])
    const en = allText(path.join(workspace, 'dist', '01-architecture', 'en'))
    // Slidev's built-in Mermaid renders client-side from the diagram source in the bundle.
    expect(en).toMatch(/mermaid/i)
    expect(en).toContain('io.github.kasperone.faktura')
    expect(findForbiddenBuildRefs(path.join(workspace, 'dist'))).toEqual([])
    expect(existsSync(path.join(workspace, 'dist', 'index.html'))).toBe(true)
  }, 180_000)
})
