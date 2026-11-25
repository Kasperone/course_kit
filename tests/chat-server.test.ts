import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveChatConfig } from '../src/lib/chat/config.js'
import { ProviderError } from '../src/lib/chat/provider.js'
import { RateLimiter, startChatServer, type ChatServer } from '../src/lib/chat/server.js'
import { parseRange } from '../src/lib/chat/static.js'
import {
  askRaw,
  chatWorkspace,
  fakeProvider,
  parseSse,
  raw,
  type FakeTurn,
} from './helpers/chat.js'
import { makeTempDir } from './helpers/tmp.js'

const KEY = 'sk-ant-secret-key-for-tests-0001'
const ASK = { lesson: '01-x', lang: 'en', slide: 1, click: 1, question: 'Why Spring Boot?' }

let server: ChatServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(
  opts: {
    turns?: FakeTurn[]
    chat?: Parameters<typeof resolveChatConfig>[0]
    pack?: boolean
    noProvider?: boolean
    env?: NodeJS.ProcessEnv
    disabled?: boolean
    staticDir?: boolean
  } = {},
) {
  const { ws } = chatWorkspace({ pack: opts.pack })
  const fake = fakeProvider(opts.turns)
  const logs: string[] = []
  server = await startChatServer({
    courseDir: ws,
    port: 0,
    chat: opts.disabled ? null : resolveChatConfig(opts.chat, {}, {}),
    staticDir: opts.staticDir === false ? null : path.join(ws, 'dist'),
    ...(opts.noProvider ? {} : { provider: fake.provider }),
    env: opts.env ?? {},
    log: (l) => logs.push(l),
    heartbeatMs: 50,
  })
  return { ws, fake, logs, port: server.port }
}

describe('chat server: binding and request guards', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { port } = await start()
    expect(server!.url).toBe(`http://127.0.0.1:${port}`)
  })

  it('answers status for the page origin and refuses rebinding hosts', async () => {
    const { port } = await start()
    const ok = await raw(port, { path: '/@course-chat/v1/status?lesson=01-x&lang=en' })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toMatchObject({
      apiVersion: 1,
      answers: 'ready',
      pack: 'ok',
      lesson: '01-x',
      title: 'Shop architecture',
      slides: 2,
    })
    expect(ok.headers['access-control-allow-origin']).toBeUndefined()
    for (const host of [
      'evil.test',
      `evil.test:${port}`,
      `192.168.1.5:${port}`,
      `127.0.0.1.evil.test:${port}`,
    ]) {
      const r = await raw(port, {
        path: '/@course-chat/v1/status?lesson=01-x&lang=en',
        headers: { host },
      })
      expect(r.status).toBe(403)
    }
    // The same guard protects the static files.
    expect((await raw(port, { path: '/', headers: { host: `evil.test:${port}` } })).status).toBe(
      403,
    )
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const r = await raw(port, {
        path: '/@course-chat/v1/status?lesson=01-x&lang=en',
        headers: { host },
      })
      expect(r.status).toBe(200)
    }
  })

  it('refuses foreign origins, cross-site fetches, missing Origin on POST and CORS preflights', async () => {
    const { port, fake } = await start()
    const foreign = await askRaw(port, ASK, { origin: 'https://evil.test' })
    expect(foreign.status).toBe(403)
    const otherPort = await askRaw(port, ASK, { origin: 'http://127.0.0.1:1' })
    expect(otherPort.status).toBe(403)
    const site = await askRaw(port, ASK, { 'sec-fetch-site': 'cross-site' })
    expect(site.status).toBe(403)
    const noOrigin = await raw(port, {
      method: 'POST',
      path: '/@course-chat/v1/ask',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ASK),
    })
    expect(noOrigin.status).toBe(403)
    const preflight = await raw(port, {
      method: 'OPTIONS',
      path: '/@course-chat/v1/ask',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
    })
    expect(preflight.status).toBe(405)
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  it('validates method, content type, size and the request body', async () => {
    const { port, fake } = await start()
    expect((await raw(port, { path: '/@course-chat/v1/ask' })).status).toBe(405)
    expect((await askRaw(port, ASK, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await askRaw(port, 'x'.repeat(33 * 1024))).status).toBe(413)
    expect((await askRaw(port, '{not json')).status).toBe(400)
    expect((await askRaw(port, { ...ASK, extra: true })).status).toBe(400)
    expect((await askRaw(port, { ...ASK, slide: 3 })).status).toBe(400)
    expect((await raw(port, { path: '/@course-chat/v1/nope' })).status).toBe(404)
    expect(fake.calls).toHaveLength(0)
  })

  it('never resolves lesson paths outside lessons/ or through symlinks', async () => {
    const { port, ws } = await start()
    for (const lesson of ['..', '../x', '%2e%2e', '01-x/../..', '/etc']) {
      const r = await askRaw(port, { ...ASK, lesson })
      expect(r.status).toBe(400)
    }
    expect((await askRaw(port, { ...ASK, lang: 'de' })).status).toBe(404)
    expect((await askRaw(port, { ...ASK, lesson: '02-none' })).status).toBe(404)
    const st = await raw(port, { path: '/@course-chat/v1/status?lesson=..%2F..&lang=en' })
    expect(st.status).toBe(400)
    expect(st.body).not.toContain(ws)

    const outside = makeTempDir('outside')
    mkdirSync(path.join(outside, 'en'), { recursive: true })
    writeFileSync(path.join(outside, 'en', 'slides.md'), '# secret\n')
    symlinkSync(outside, path.join(ws, 'lessons', '03-link'))
    const linked = await askRaw(port, { ...ASK, lesson: '03-link' })
    expect([400, 404]).toContain(linked.status)
  })
})

describe('chat server: answers', () => {
  it('streams an answer as SSE with sources and usage', async () => {
    const { port, fake, logs } = await start({
      turns: [{ deltas: ['From slide 1.\n[[gen', 'eral]]\nIn general...', ' done'] }],
    })
    const r = await askRaw(port, {
      ...ASK,
      history: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
      ],
    })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(r.headers['cache-control']).toBe('no-store')
    const events = parseSse(r.body)
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'delta', 'done'])
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data)).toEqual([
      { text: 'From slide 1.\n', source: 'lesson' },
      { text: 'In general...', source: 'general' },
      { text: ' done', source: 'general' },
    ])
    expect(events.at(-1)!.data).toMatchObject({ stopReason: 'end_turn', usage: { cacheRead: 100 } })

    const { req } = fake.calls[0]!
    expect(req.effort).toBe('low')
    expect(req.maxTokens).toBe(8000)
    expect(req.system[1]!.text).toContain('<context_pack')
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(logs.at(-1)).toMatch(
      /^ask 01-x\/en slide 1 · anthropic-api claude-fake · \d+ ms · in 10 \(cache read 100, write 0\) out 5 · end_turn$/,
    )
    expect(logs.join('\n')).not.toContain('Why Spring Boot')
  })

  it('flags off-topic questions and reports refusals, cut-offs and provider errors', async () => {
    const { port } = await start({
      chat: { rateLimit: { perMinute: 10 } },
      turns: [
        { deltas: ['[[off-topic]]\nLet us stay with the lesson.'] },
        { deltas: [], stopReason: 'refusal' },
        { deltas: ['long'], stopReason: 'max_tokens' },
        {
          error: new ProviderError(
            'offline',
            `Cannot reach the API ${KEY} via http://u:proxy-pw-s3cr3t@proxy.example:3128`,
          ),
        },
      ],
      env: { ANTHROPIC_API_KEY: KEY },
    })
    const offTopic = parseSse((await askRaw(port, ASK)).body)
    expect(offTopic[1]).toEqual({ event: 'scope', data: { value: 'off-topic' } })
    expect(parseSse((await askRaw(port, ASK)).body).at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'refused' },
    })
    expect(parseSse((await askRaw(port, ASK)).body).at(-1)).toMatchObject({
      event: 'done',
      data: { stopReason: 'max_tokens' },
    })
    const failed = await askRaw(port, ASK)
    expect(parseSse(failed.body).at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'offline' },
    })
    expect(failed.body).not.toContain(KEY)
    // A proxy URL in a provider error reaches the browser without its password.
    expect(failed.body).toContain('http://u:‹redacted›@proxy.example:3128')
    expect(failed.body).not.toContain('proxy-pw-s3cr3t')
  })

  it('aborts the upstream answer when the browser goes away', async () => {
    const { port, fake, logs } = await start({ turns: [{ hang: true }] })
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/@course-chat/v1/ask',
          headers: {
            host: `127.0.0.1:${port}`,
            origin: `http://127.0.0.1:${port}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        },
      )
      req.on('error', () => {})
      req.end(JSON.stringify(ASK))
    })
    await expect.poll(() => fake.calls[0]?.signal.aborted).toBe(true)
    await expect.poll(() => logs.at(-1)).toMatch(/· aborted$/)
  })

  it('sends a heartbeat while the model thinks', async () => {
    const { port } = await start({ turns: [{ deltas: ['a', 'b'], delayMs: 120 }] })
    const r = await askRaw(port, ASK)
    expect(r.body).toContain(': ping')
  })

  it('without a key: status says no-key and ask returns 503 (no failure, no network)', async () => {
    const { port } = await start({ noProvider: true })
    const st = JSON.parse(
      (await raw(port, { path: '/@course-chat/v1/status?lesson=01-x&lang=pl' })).body,
    ) as { answers: string }
    expect(st.answers).toBe('no-key')
    const r = await askRaw(port, ASK)
    expect(r.status).toBe(503)
    expect(JSON.parse(r.body)).toMatchObject({ error: 'no-key' })
  })

  it('uses the workspace key with the provider factory and never echoes it', async () => {
    const { ws } = chatWorkspace()
    writeFileSync(path.join(ws, '.env'), `ANTHROPIC_API_KEY=${KEY}\n`)
    const fake = fakeProvider()
    const keys: string[] = []
    server = await startChatServer({
      courseDir: ws,
      port: 0,
      chat: resolveChatConfig(undefined, {}, {}),
      env: {},
      providerFactory: async (k) => {
        keys.push(k)
        return fake.provider
      },
    })
    const st = await raw(server.port, { path: '/@course-chat/v1/status?lesson=01-x&lang=en' })
    expect(JSON.parse(st.body)).toMatchObject({ answers: 'ready' })
    const r = await askRaw(server.port, ASK)
    expect(r.status).toBe(200)
    await askRaw(server.port, ASK)
    expect(keys).toEqual([KEY])
    expect(st.body + r.body).not.toContain(KEY)
  })

  it('without a context pack: status says missing and ask is refused', async () => {
    const { port, fake } = await start({ pack: false })
    const st = JSON.parse(
      (await raw(port, { path: '/@course-chat/v1/status?lesson=01-x&lang=en' })).body,
    ) as { pack: string; problem: string }
    expect(st.pack).toBe('missing')
    expect(st.problem).toMatch(/course context 01-x/)
    const r = await askRaw(port, ASK)
    expect(r.status).toBe(422)
    expect(JSON.parse(r.body)).toMatchObject({ error: 'no-pack' })
    expect(fake.calls).toHaveLength(0)
  })

  it('disabled chat answers status but no questions', async () => {
    const { port } = await start({ disabled: true })
    const st = JSON.parse((await raw(port, { path: '/@course-chat/v1/status' })).body) as {
      answers: string
    }
    expect(st.answers).toBe('disabled')
    expect((await askRaw(port, ASK)).status).toBe(503)
  })
})

describe('chat server: limits', () => {
  it('rate-limits questions per minute with Retry-After', async () => {
    const { port } = await start({ chat: { rateLimit: { perMinute: 2 } } })
    expect((await askRaw(port, ASK)).status).toBe(200)
    expect((await askRaw(port, ASK)).status).toBe(200)
    const limited = await askRaw(port, ASK)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(JSON.parse(limited.body)).toMatchObject({ error: 'rate-limited' })
  })

  it('runs one answer at a time', async () => {
    const { port } = await start({ turns: [{ deltas: ['a', 'b', 'c'], delayMs: 100 }] })
    const first = askRaw(port, ASK)
    await new Promise((r) => setTimeout(r, 50))
    const second = await askRaw(port, ASK)
    expect(second.status).toBe(429)
    expect(JSON.parse(second.body)).toMatchObject({ error: 'busy' })
    expect((await first).status).toBe(200)
  })

  it('RateLimiter: minute window and daily cap', () => {
    let t = Date.parse('2026-11-21T10:00:00Z')
    const rl = new RateLimiter(2, 3, () => t)
    expect(rl.take().ok).toBe(true)
    expect(rl.take().ok).toBe(true)
    expect(rl.take()).toEqual({ ok: false, retryAfter: 60 })
    t += 61_000
    expect(rl.take().ok).toBe(true)
    t += 61_000
    const capped = rl.take()
    expect(capped.ok).toBe(false)
    t = Date.parse('2026-11-22T00:00:01Z')
    expect(rl.take().ok).toBe(true)
  })
})

describe('chat server: the workspace path never reaches the browser or the log', () => {
  it('a malformed course.json is a 500 without the absolute path', async () => {
    const { port, ws, logs } = await start()
    writeFileSync(path.join(ws, 'course.json'), '{ not json')
    const res = await raw(port, {
      path: '/@course-chat/v1/status?lesson=01-x&lang=en',
    })
    expect(res.status).toBe(500)
    const body = JSON.parse(res.body) as { error: string; message: string }
    expect(body.error).toBe('internal')
    expect(body.message).toContain('<workspace>')
    expect(res.body).not.toContain(ws)
    expect(logs.join('\n')).not.toContain(ws)
  })
})

describe('course serve static files', () => {
  it('serves dist/ with traversal and symlink protection and byte ranges', async () => {
    const { port, ws } = await start()
    expect((await raw(port, { path: '/' })).body).toBe('<html>index</html>')
    const redirect = await raw(port, { path: '/01-x/en' })
    expect(redirect.status).toBe(301)
    expect(redirect.headers.location).toBe('/01-x/en/')
    expect((await raw(port, { path: '/01-x/en/' })).body).toBe('<html>deck en</html>')
    for (const p of [
      '/../course.json',
      '/%2e%2e/course.json',
      '/01-x/..%2f..%2fcourse.json',
      '/a%5cb',
      '/a%00b',
    ]) {
      expect((await raw(port, { path: p })).status).toBe(400)
    }
    writeFileSync(path.join(ws, 'secret.txt'), 'secret')
    symlinkSync(path.join(ws, 'secret.txt'), path.join(ws, 'dist', 'link.txt'))
    symlinkSync(path.join(ws, 'lessons'), path.join(ws, 'dist', 'lessons'))
    expect((await raw(port, { path: '/link.txt' })).status).toBe(404)
    expect((await raw(port, { path: '/lessons/01-x/context-pack.md' })).status).toBe(404)
    const clip = '/01-x/narration/en/s01-c00-0123456789ab.mp3'
    const full = await raw(port, { path: clip })
    expect(full.headers['content-type']).toBe('audio/mpeg')
    expect(full.headers['accept-ranges']).toBe('bytes')
    const part = await raw(port, { path: clip, headers: { range: 'bytes=3-5' } })
    expect(part.status).toBe(206)
    expect(part.body).toBe('-01')
    expect(part.headers['content-range']).toBe('bytes 3-5/14')
    expect((await raw(port, { path: clip, headers: { range: 'bytes=99-' } })).status).toBe(416)
    expect((await raw(port, { method: 'POST', path: '/' })).status).toBe(405)
  })

  // root can read a mode-000 file, so there is nothing to fail on.
  it.skipIf(process.getuid?.() === 0)(
    'one unreadable file ends that response, not the server',
    async () => {
      const { port, ws } = await start()
      const locked = path.join(ws, 'dist', 'locked.js')
      writeFileSync(locked, 'console.log(1)')
      chmodSync(locked, 0o000)
      try {
        // The headers are already out when the open fails: the response is cut, whatever the client sees.
        await raw(port, { path: '/locked.js' }).catch(() => null)
        // The process is alive and keeps serving.
        expect((await raw(port, { path: '/' })).body).toBe('<html>index</html>')
        // A file removed after the stat (`course build` clears dist/ while the server runs) is the
        // same case: nothing throws.
        rmSync(locked)
        expect((await raw(port, { path: '/locked.js' })).status).toBe(404)
        expect((await raw(port, { path: '/' })).status).toBe(200)
      } finally {
        rmSync(locked, { force: true })
      }
    },
  )

  it('parseRange', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=2-100', 10)).toEqual({ start: 2, end: 9 })
    for (const h of ['bytes=5-2', 'bytes=-0', 'bytes=10-', 'items=0-1', 'bytes=0-1,3-4']) {
      expect(parseRange(h, 10)).toBe('invalid')
    }
  })

  it('without a static dir, only the API exists', async () => {
    const { port } = await start({ staticDir: false })
    expect((await raw(port, { path: '/' })).status).toBe(404)
  })
})
