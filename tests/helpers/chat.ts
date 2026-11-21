import { mkdirSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import type { CourseJson } from '../../src/commands/init.js'
import {
  ProviderError,
  type AnswerEvent,
  type AnswerProvider,
  type AnswerRequest,
} from '../../src/lib/chat/provider.js'
import { deckFrontmatter } from '../../src/lib/slidev.js'
import { makeTempDir } from './tmp.js'

export const SHA = 'b'.repeat(40)

export const DECK = (lang: string) => `${deckFrontmatter({ title: 'Shop architecture', lang })}

# Overview

Spring Boot app.

<!--
Welcome. [click] First point.
-->

---

# Second

\`\`\`java
class App {}
\`\`\`

<!--
Only one step.
-->
`

export const PACK = `# Context pack

| Field | Value |
|-------|-------|
| Pinned commit | \`${SHA}\` |

## Files

src/App.java:1 class App {}
`

/** A minimal course workspace with lesson 01-x (en, pl), a context pack and a built dist/. */
export function chatWorkspace(opts: { pack?: boolean; chat?: unknown } = {}): {
  ws: string
  course: CourseJson
} {
  const ws = makeTempDir('chat')
  const course: CourseJson = {
    schemaVersion: 1,
    targetRepo: null,
    targetRemote: 'https://example.invalid/acme/shop.git',
    pinnedCommit: SHA,
    languages: ['en', 'pl'],
    referenceMode: 'pinned-path',
    submodulePath: null,
    ...(opts.chat ? { chat: opts.chat as CourseJson['chat'] } : {}),
  }
  const files: Record<string, string> = {
    'course.json': JSON.stringify(course),
    'lessons/01-x/en/slides.md': DECK('en'),
    'lessons/01-x/pl/slides.md': DECK('pl'),
    'dist/index.html': '<html>index</html>',
    'dist/01-x/en/index.html': '<html>deck en</html>',
    'dist/01-x/narration/en/s01-c00-0123456789ab.mp3': 'ID3-0123456789',
  }
  if (opts.pack !== false) files['lessons/01-x/context-pack.md'] = PACK
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true })
    writeFileSync(path.join(ws, rel), text)
  }
  return { ws, course }
}

export type FakeTurn =
  | { deltas: string[]; stopReason?: string; delayMs?: number }
  | { error: ProviderError }
  | { hang: true }

/** An AnswerProvider that replays scripted turns and records what it was asked. */
export function fakeProvider(turns: FakeTurn[] = []) {
  const calls: Array<{ req: AnswerRequest; signal: AbortSignal }> = []
  const provider: AnswerProvider = {
    id: 'fake',
    model: 'claude-fake',
    async *answer(req, signal): AsyncIterable<AnswerEvent> {
      calls.push({ req, signal })
      const turn = turns.shift() ?? { deltas: ['ok'] }
      if ('error' in turn) throw turn.error
      if ('hang' in turn) {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'aborted'))),
        )
        return
      }
      for (const text of turn.deltas) {
        if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs))
        if (signal.aborted) throw new ProviderError('aborted', 'aborted')
        yield { type: 'text', text }
      }
      yield {
        type: 'done',
        stopReason: turn.stopReason ?? 'end_turn',
        model: 'claude-fake',
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
      }
    },
  }
  return { provider, calls }
}

export type RawResponse = { status: number; headers: Record<string, unknown>; body: string }

/** HTTP request with full control over Host/Origin (fetch forbids setting some of them). */
export function raw(
  port: number,
  opts: {
    method?: string
    path: string
    headers?: Record<string, string>
    body?: string | Buffer
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

export type SseEvent = { event: string; data: unknown }

export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1] ?? 'message'
      const data = block.match(/^data: (.*)$/m)?.[1]
      return { event, data: data ? (JSON.parse(data) as unknown) : null }
    })
}

/** POST /ask from the page's own origin. */
export function askRaw(port: number, body: unknown, headers: Record<string, string> = {}) {
  return raw(port, {
    method: 'POST',
    path: '/@course-chat/v1/ask',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
