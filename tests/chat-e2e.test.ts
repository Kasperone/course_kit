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
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runServe } from '../src/commands/serve.js'
import { slidevBin } from '../src/commands/slidev.js'
import { resolveChatConfig } from '../src/lib/chat/config.js'
import { createAnthropicProvider } from '../src/lib/chat/provider.js'
import { startChatServer } from '../src/lib/chat/server.js'
import { withoutSecrets } from '../src/lib/env.js'
import { findForbiddenBuildRefs } from '../src/lib/slidev.js'
import { DECK, PACK, SHA, parseSse, raw } from './helpers/chat.js'
import { startFakeAnthropic } from './helpers/fake-anthropic.js'

/**
 * Q&A chat end to end with the real Slidev 52.20.1 of the example workspace (skipped unless
 * `npm ci --prefix examples/faktura` was run; the CI `deck` job runs it). A probe mini-workspace
 * inside examples/faktura (so Slidev and the addons resolve) holds one lesson and a fixture
 * context pack; it never touches the real lessons/ or dist/. Claude is a local mock of the
 * Messages API: no network, no key.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.join(repoRoot, 'examples', 'faktura')
const installed = existsSync(path.join(workspace, 'node_modules', '@slidev', 'cli', 'package.json'))

const probes: string[] = []
afterAll(() => {
  for (const dir of probes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** examples/faktura/.e2e-chat-*: course.json + lessons/probe/en (deck, pack). */
function probeWorkspace(): { dir: string; entry: string } {
  const dir = mkdtempSync(path.join(workspace, '.e2e-chat-'))
  probes.push(dir)
  const course = {
    schemaVersion: 1,
    targetRepo: null,
    targetRemote: 'https://example.invalid/acme/shop.git',
    pinnedCommit: SHA,
    languages: ['en'],
    referenceMode: 'pinned-path',
    submodulePath: null,
  }
  writeFileSync(path.join(dir, 'course.json'), JSON.stringify(course))
  const lesson = path.join(dir, 'lessons', 'probe')
  mkdirSync(path.join(lesson, 'en'), { recursive: true })
  writeFileSync(path.join(lesson, 'en', 'slides.md'), DECK('en'))
  writeFileSync(path.join(lesson, 'context-pack.md'), PACK)
  return { dir, entry: path.join(lesson, 'en', 'slides.md') }
}

function slidevBuild(entry: string, out: string, base: string): void {
  execFileSync(
    process.execPath,
    [slidevBin(workspace), 'build', entry, '--out', out, '--base', base, '--router-mode', 'hash'],
    { cwd: workspace, stdio: 'pipe', env: withoutSecrets() },
  )
}

function allText(dir: string): string {
  let out = ''
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(html|js|css)$/.test(entry.name)) {
      out += readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
    }
  }
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

/** POST /ask and record when each SSE event arrives (to tell streaming from buffering). */
function askTimed(
  host: string,
  port: number,
  origin: string,
): Promise<{ status: number; events: Array<{ event: string; data: unknown; at: number }> }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = httpRequest(
      {
        host,
        port,
        method: 'POST',
        path: '/@course-chat/v1/ask',
        headers: { host: `${host}:${port}`, origin, 'content-type': 'application/json' },
      },
      (res) => {
        const events: Array<{ event: string; data: unknown; at: number }> = []
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end + 2)
            buffer = buffer.slice(end + 2)
            for (const e of parseSse(block)) events.push({ ...e, at: Date.now() - started })
          }
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, events }))
      },
    )
    req.on('error', reject)
    req.end(
      JSON.stringify({ lesson: 'probe', lang: 'en', slide: 2, click: 0, question: 'Why a class?' }),
    )
  })
}

describe.skipIf(!installed)('Q&A chat with real Slidev (examples/faktura)', () => {
  it('built deck + course serve: panel config in the bundle, answers on one local origin', async () => {
    const { dir, entry } = probeWorkspace()
    const out = path.join(dir, 'dist', 'probe', 'en')
    slidevBuild(entry, out, '/probe/en/')
    writeFileSync(path.join(dir, 'dist', 'index.html'), '<html>probe</html>')
    const bundle = allText(out)
    expect(bundle).toContain('lesson:`probe`,lang:`en`,api:`/@course-chat/v1/`')
    expect(bundle).toContain('course-chat')
    expect(findForbiddenBuildRefs(out)).toEqual([])
    expect(bundle).not.toMatch(/api\.anthropic\.com|api\.elevenlabs\.io/)

    // Negative control: a deck outside lessons/<id>/<lang>/ gets no chat config.
    const other = path.join(dir, 'other')
    mkdirSync(other)
    writeFileSync(path.join(other, 'slides.md'), DECK('en'))
    const otherOut = path.join(dir, 'other-out')
    slidevBuild(path.join(other, 'slides.md'), otherOut, '/')
    expect(allText(otherOut)).not.toContain('api:`/@course-chat/v1/`')

    const fake = await startFakeAnthropic([
      { kind: 'stream', deltas: ['See slide 2.', '\n[[general]]\n', 'In general...'] },
    ])
    const provider = await createAnthropicProvider({
      apiKey: 'sk-ant-e2e-fake',
      model: 'claude-sonnet-5-5',
      refusalFallback: true,
      baseURL: fake.url,
      maxRetries: 0,
    })
    const served = await runServe({ cwd: dir, port: 0, env: {}, answerProvider: provider })
    try {
      const page = await raw(served.port, { path: '/probe/en/' })
      expect(page.status).toBe(200)
      const script = page.body.match(/src="(\/probe\/en\/assets\/[^"]+\.js)"/)?.[1]
      expect(script).toBeDefined()
      expect((await raw(served.port, { path: script! })).status).toBe(200)

      const st = await raw(served.port, { path: '/@course-chat/v1/status?lesson=probe&lang=en' })
      expect(JSON.parse(st.body)).toMatchObject({ answers: 'ready', pack: 'ok', slides: 2 })

      const r = await askTimed('127.0.0.1', served.port, `http://127.0.0.1:${served.port}`)
      expect(r.status).toBe(200)
      const bySource: Array<{ text: string; source: string }> = []
      for (const e of r.events.filter((x) => x.event === 'delta')) {
        const d = e.data as { text: string; source: string }
        const last = bySource.at(-1)
        if (last?.source === d.source) last.text += d.text
        else bySource.push({ ...d })
      }
      expect(bySource).toEqual([
        { text: 'See slide 2.\n', source: 'lesson' },
        { text: 'In general...', source: 'general' },
      ])
      expect(r.events.at(-1)!.event).toBe('done')
      expect(fake.requests[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true })

      const foreign = await askTimed('127.0.0.1', served.port, 'https://evil.test')
      expect(foreign.status).toBe(403)
      const rebound = await raw(served.port, {
        path: '/probe/en/',
        headers: { host: `attacker.test:${served.port}` },
      })
      expect(rebound.status).toBe(403)
    } finally {
      await served.close()
      await fake.close()
    }
  }, 240_000)

  it('course dev: the Vite proxy forwards to the backend and streams without buffering', async () => {
    const { dir, entry } = probeWorkspace()
    const fake = await startFakeAnthropic([
      { kind: 'stream', deltas: ['one ', 'two ', 'three'], delayMs: 400 },
    ])
    const provider = await createAnthropicProvider({
      apiKey: 'sk-ant-e2e-fake',
      model: 'claude-sonnet-5-5',
      refusalFallback: true,
      baseURL: fake.url,
      maxRetries: 0,
    })
    const chat = await startChatServer({
      courseDir: dir,
      port: 0,
      chat: resolveChatConfig(undefined, {}, {}),
      provider,
      env: {},
    })
    const port = await freePort()
    const child = spawn(process.execPath, [slidevBin(workspace), entry, '--port', String(port)], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...withoutSecrets(), COURSE_CHAT_PORT: String(chat.port) },
    })
    let out = ''
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`dev server did not start:\n${out}`)),
          90_000,
        )
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          if (out.includes('slides overview')) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.on('exit', (code) => reject(new Error(`dev server exited (${code}):\n${out}`)))
      })
      const env = await (await fetch(`http://localhost:${port}/@vite/env`)).text()
      expect(env).toBeTruthy()

      const r = await askTimed('localhost', port, `http://localhost:${port}`)
      expect(r.status).toBe(200)
      const deltas = r.events.filter((e) => e.event === 'delta')
      expect(deltas.map((e) => (e.data as { text: string }).text).join('')).toBe('one two three')
      // Streamed through the proxy: the deltas arrive spread out, not all at the end.
      expect(deltas.at(-1)!.at - deltas[0]!.at).toBeGreaterThanOrEqual(500)

      const foreign = await askTimed('localhost', port, 'https://evil.test')
      expect(foreign.status).toBe(403)
    } finally {
      child.kill()
      await chat.close()
      await fake.close()
    }
  }, 240_000)
})
