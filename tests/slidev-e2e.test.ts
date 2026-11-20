import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runBuild, slidevBin } from '../src/commands/slidev.js'
import {
  deckFrontmatter,
  findForbiddenBuildRefs,
  PLANTUML_DISABLED_SERVER,
} from '../src/lib/slidev.js'

/**
 * Real Slidev builds against the committed example workspace. Runs only when its dependencies are
 * installed (`npm ci --prefix examples/faktura`, done by the CI `deck` job); skipped otherwise.
 * Each policy (PlantUML server, system fonts, no browser exporter) is checked together with a
 * negative control that shows what Slidev does without it.
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
async function devFetch(entry: string, paths: string[]): Promise<string[]> {
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
    for (const p of paths) bodies.push(await (await fetch(`http://localhost:${port}${p}`)).text())
    return bodies
  } finally {
    child.kill()
  }
}

const flag = (env: string, name: string) => env.match(new RegExp(`"${name}":\\s*(true|false)`))?.[1]

/** Headmatter with one policy entry removed (for negative controls). */
const without = (pattern: RegExp) => OFFLINE.replace(pattern, '')

describe.skipIf(!installed)('real Slidev (examples/faktura)', () => {
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

  it('dev server: no /export or /print page and no web fonts; the defaults enable both', async () => {
    try {
      const [env, page] = await devFetch(probeDeck(OFFLINE, ''), ['/@vite/env', '/'])
      expect(flag(env!, '__SLIDEV_FEATURE_BROWSER_EXPORTER__')).toBe('false')
      expect(flag(env!, '__SLIDEV_FEATURE_PRINT__')).toBe('false')
      expect(page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/)

      const defaults = OFFLINE.replace(/^browserExporter:.*\n/m, '').replace(
        /^fonts:\n(?: {2}.*\n)+/m,
        '',
      )
      const [envOn, pageOn] = await devFetch(probeDeck(defaults, ''), ['/@vite/env', '/'])
      expect(flag(envOn!, '__SLIDEV_FEATURE_BROWSER_EXPORTER__')).toBe('true')
      expect(pageOn).toContain('fonts.googleapis.com')
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
