import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * A local stand-in for the Anthropic Messages API (POST /v1/messages, streaming). It records each
 * request (headers and JSON body) and answers with scripted SSE frames, so the real SDK can be
 * tested without network access or a key.
 */
export type FakeReply =
  | {
      kind: 'stream'
      deltas: string[]
      /** Pause between deltas (lets tests check incremental delivery). */
      delayMs?: number
      stopReason?: string
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    }
  | { kind: 'error'; status: number; type?: string; message?: string }
  /** Accept the request and never answer (abort tests). */
  | { kind: 'hang' }

export type RecordedRequest = {
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
  /** Set when the client went away before the reply finished. */
  closedEarly: boolean
}

export type FakeAnthropic = {
  url: string
  requests: RecordedRequest[]
  replies: FakeReply[]
  close(): Promise<void>
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startFakeAnthropic(replies: FakeReply[] = []): Promise<FakeAnthropic> {
  const state: FakeAnthropic = { url: '', requests: [], replies, close: async () => {} }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const record: RecordedRequest = {
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
            string,
            unknown
          >,
          closedEarly: false,
        }
        state.requests.push(record)
        res.on('close', () => {
          if (!res.writableFinished) record.closedEarly = true
        })
        const reply = state.replies.shift() ?? { kind: 'stream', deltas: ['ok'] }
        if (reply.kind === 'hang') return
        if (reply.kind === 'error') {
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: reply.type ?? 'api_error', message: reply.message ?? 'error' },
            }),
          )
          return
        }
        const model = String(record.body.model ?? 'claude-test')
        const u = reply.usage ?? {}
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(
          frame('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_fake',
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: u.input ?? 20,
                output_tokens: 1,
                cache_read_input_tokens: u.cacheRead ?? 0,
                cache_creation_input_tokens: u.cacheWrite ?? 0,
              },
            },
          }),
        )
        res.write(
          frame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        )
        for (const text of reply.deltas) {
          if (res.destroyed) return
          if (reply.delayMs) await sleep(reply.delayMs)
          res.write(
            frame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            }),
          )
        }
        res.write(frame('content_block_stop', { type: 'content_block_stop', index: 0 }))
        res.write(
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: reply.stopReason ?? 'end_turn', stop_sequence: null },
            usage: { output_tokens: u.output ?? 7 },
          }),
        )
        res.end(frame('message_stop', { type: 'message_stop' }))
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  state.url = `http://127.0.0.1:${port}`
  state.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return state
}
