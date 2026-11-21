import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_VERSION,
  appendChunk,
  askStream,
  errorText,
  fetchStatus,
  panelState,
  parseInline,
  parseMarkdown,
  SseParser,
  strings,
  type AnswerChunk,
  type SseEvent,
} from '../templates/workspace/addons/chat/chat-client.js'
import { EXTERNAL_URL_RE } from '../src/lib/slidev.js'

const addon = path.join(__dirname, '..', 'templates', 'workspace', 'addons', 'chat')

afterEach(() => vi.unstubAllGlobals())

describe('chat client: SSE', () => {
  it('parses events split anywhere and skips comments', () => {
    const text =
      ': ping\n\nevent: delta\ndata: {"text":"a","source":"lesson"}\n\nevent: done\r\ndata: {"stopReason":"end_turn"}\r\n\r\n'
    const all: SseEvent[] = []
    const p = new SseParser()
    for (const ch of text) all.push(...p.push(ch))
    expect(all).toEqual([
      { event: 'delta', data: { text: 'a', source: 'lesson' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ])
  })

  it('askStream: posts JSON to the same-origin API and reports HTTP errors as events', async () => {
    const calls: Array<[string, RequestInit]> = []
    const body =
      'event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n'
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push([url, init])
      return calls.length === 1
        ? new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify({ error: 'rate-limited', message: 'slow down' }), {
            status: 429,
          })
    })
    const events: SseEvent[] = []
    const req = { lesson: '01-x', lang: 'pl', slide: 2, click: 1, question: 'q', history: [] }
    await askStream('/@course-chat/v1/', req, new AbortController().signal, (e) => events.push(e))
    await askStream('/@course-chat/v1/', req, new AbortController().signal, (e) => events.push(e))
    expect(calls[0]![0]).toBe('/@course-chat/v1/ask')
    expect(calls[0]![1].method).toBe('POST')
    expect(JSON.parse(String(calls[0]![1].body))).toEqual(req)
    expect(events.map((e) => e.event)).toEqual(['delta', 'done', 'error'])
    expect(events[2]!.data).toEqual({ code: 'rate-limited', message: 'slow down' })
  })

  it('fetchStatus: null when the backend is not there (static preview, offline)', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 404 }))
    expect(await fetchStatus('/@course-chat/v1/', '01-x', 'en')).toBeNull()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network')
    })
    expect(await fetchStatus('/@course-chat/v1/', '01-x', 'en')).toBeNull()
    vi.stubGlobal(
      'fetch',
      async (url: string) =>
        new Response(JSON.stringify({ apiVersion: 1, answers: 'ready', pack: 'ok', url }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    expect(await fetchStatus('/@course-chat/v1/', '01-x', 'en')).toMatchObject({
      url: '/@course-chat/v1/status?lesson=01-x&lang=en',
    })
  })
})

describe('chat client: rendering', () => {
  it('turns links and images into plain text and never yields HTML', () => {
    expect(
      parseInline(
        'See [docs](https://evil.test/x) and ![img](https://evil.test/p.png) <img src=x>',
      ),
    ).toEqual([{ t: 'text', v: 'See docs and [img] ' }])
    expect(parseInline('Use `IssueService` with **care** on slide 3')).toEqual([
      { t: 'text', v: 'Use ' },
      { t: 'code', v: 'IssueService' },
      { t: 'text', v: ' with ' },
      { t: 'strong', v: 'care' },
      { t: 'text', v: ' on ' },
      { t: 'slide', v: 'slide 3', n: 3 },
    ])
    expect(parseInline('Na slajdzie 5 widać')).toContainEqual({ t: 'slide', v: 'slajdzie 5', n: 5 })
  })

  it('parses paragraphs, lists and fenced code', () => {
    const md = '# Title\nIntro line\nmore\n\n- a\n- `b`\n1. one\n\n```java\nclass A {}\n```\nEnd'
    expect(parseMarkdown(md)).toEqual([
      { t: 'p', inl: [{ t: 'text', v: 'Title Intro line more' }] },
      { t: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'code', v: 'b' }]] },
      { t: 'ol', items: [[{ t: 'text', v: 'one' }]] },
      { t: 'code', v: 'class A {}' },
      { t: 'p', inl: [{ t: 'text', v: 'End' }] },
    ])
  })

  it('merges chunks by source', () => {
    const chunks: AnswerChunk[] = []
    appendChunk(chunks, 'lesson', 'a')
    appendChunk(chunks, 'lesson', 'b')
    appendChunk(chunks, 'general', 'c')
    expect(chunks).toEqual([
      { source: 'lesson', text: 'ab' },
      { source: 'general', text: 'c' },
    ])
  })
})

describe('chat client: states and strings', () => {
  it('maps status to a panel state', () => {
    const ok = { apiVersion: API_VERSION, answers: 'ready' as const, pack: 'ok' as const }
    expect(panelState(null)).toBe('offline')
    expect(panelState({ ...ok, apiVersion: 99 })).toBe('outdated')
    expect(panelState({ ...ok, answers: 'disabled' })).toBe('disabled')
    expect(panelState({ ...ok, pack: 'missing' })).toBe('no-pack')
    expect(panelState({ ...ok, answers: 'no-key' })).toBe('no-key')
    expect(panelState({ ...ok, pack: 'stale' })).toBe('stale')
    expect(panelState(ok)).toBe('ready')
  })

  it('has Polish and English strings with the same keys', () => {
    const en = strings('en')
    const pl = strings('pl')
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(pl.state).sort()).toEqual(Object.keys(en.state).sort())
    expect(Object.keys(pl.errors).sort()).toEqual(Object.keys(en.errors).sort())
    expect(pl.notFromLesson).toBe('Spoza tej lekcji')
    expect(strings('de')).toBe(en)
    expect(errorText(en, 'refused', '')).toMatch(/declined/)
    expect(errorText(en, 'weird', 'boom')).toBe('The answer failed: boom')
  })

  it('addon code has no external URLs and no v-html (deck offline policy)', () => {
    for (const f of ['global-top.vue', 'chat-client.ts', 'setup/vite-plugins.ts']) {
      const text = readFileSync(path.join(addon, f), 'utf8')
      expect(EXTERNAL_URL_RE.test(text), f).toBe(false)
      expect(text).not.toMatch(/v-html|innerHTML/)
    }
  })
})
