import { afterEach, describe, expect, it } from 'vitest'
import {
  createAnthropicProvider,
  estimateCost,
  ProviderError,
  REFUSAL_FALLBACK_BETA,
  type AnswerEvent,
  type AnswerRequest,
} from '../src/lib/chat/provider.js'
import { startFakeAnthropic, type FakeAnthropic } from './helpers/fake-anthropic.js'

const KEY = 'sk-ant-test-0123456789abcdef'

const REQ: AnswerRequest = {
  system: [
    { type: 'text', text: 'instructions' },
    { type: 'text', text: '<lesson_materials/>', cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: 'Why?' }],
  maxTokens: 8000,
  effort: 'low',
}

let fake: FakeAnthropic | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

async function collect(it: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

async function provider(model = 'claude-sonnet-5-5', refusalFallback = true) {
  return createAnthropicProvider({
    apiKey: KEY,
    model,
    refusalFallback,
    baseURL: fake!.url,
    maxRetries: 0,
    timeoutMs: 5000,
  })
}

describe('Anthropic provider (local mock API, no network)', () => {
  it('streams text and reports usage; sends the expected request', async () => {
    fake = await startFakeAnthropic([
      {
        kind: 'stream',
        deltas: ['Hel', 'lo'],
        usage: { input: 30, output: 12, cacheRead: 25_000, cacheWrite: 0 },
      },
    ])
    const events = await collect((await provider()).answer(REQ, new AbortController().signal))
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      {
        type: 'done',
        stopReason: 'end_turn',
        model: 'claude-sonnet-5-5',
        usage: { input: 30, output: 12, cacheRead: 25_000, cacheWrite: 0 },
      },
    ])
    const [req] = fake.requests
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(req!.headers['anthropic-beta']).toContain(REFUSAL_FALLBACK_BETA)
    expect(req!.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 8000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: REQ.system,
    })
    for (const key of ['temperature', 'top_p', 'top_k']) expect(req!.body).not.toHaveProperty(key)
  })

  it('omits the refusal fallback when disabled or unsupported by the model', async () => {
    fake = await startFakeAnthropic([
      { kind: 'stream', deltas: ['a'] },
      { kind: 'stream', deltas: ['b'] },
    ])
    await collect(
      (await provider('claude-sonnet-5-5', false)).answer(REQ, new AbortController().signal),
    )
    await collect((await provider('claude-haiku-5-5')).answer(REQ, new AbortController().signal))
    for (const r of fake.requests) {
      expect(r.body).not.toHaveProperty('fallbacks')
      expect(String(r.headers['anthropic-beta'] ?? '')).not.toContain('server-side-fallback')
    }
  })

  it('passes a refusal through as the stop reason', async () => {
    fake = await startFakeAnthropic([{ kind: 'stream', deltas: [], stopReason: 'refusal' }])
    const events = await collect((await provider()).answer(REQ, new AbortController().signal))
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'refusal' })
  })

  it('maps API failures to codes without leaking the key', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'authentication_error', 'auth'],
      [429, 'rate_limit_error', 'rate-limited'],
      [400, 'invalid_request_error', 'bad-request'],
      [500, 'api_error', 'upstream'],
      [529, 'overloaded_error', 'overloaded'],
    ]
    fake = await startFakeAnthropic(
      cases.map(([status, type]) => ({ kind: 'error', status, type, message: `bad key ${KEY}` })),
    )
    const p = await provider()
    for (const [, , code] of cases) {
      const err = await collect(p.answer(REQ, new AbortController().signal)).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe(code)
      expect((err as Error).message).not.toContain(KEY)
    }
  })

  it('reports an unreachable API as offline', async () => {
    fake = await startFakeAnthropic()
    const url = fake.url
    await fake.close()
    const p = await createAnthropicProvider({
      apiKey: KEY,
      model: 'claude-sonnet-5-5',
      refusalFallback: true,
      baseURL: url,
      maxRetries: 0,
    })
    fake = undefined
    const err = await collect(p.answer(REQ, new AbortController().signal)).catch((e: unknown) => e)
    expect((err as ProviderError).code).toBe('offline')
    expect((err as Error).message).not.toContain(KEY)
  })

  it('aborting cancels the upstream request', async () => {
    fake = await startFakeAnthropic([
      { kind: 'stream', deltas: ['a', 'b', 'c', 'd'], delayMs: 200 },
    ])
    const ac = new AbortController()
    const p = await provider()
    const seen: AnswerEvent[] = []
    const err = await (async () => {
      for await (const e of p.answer(REQ, ac.signal)) {
        seen.push(e)
        ac.abort()
      }
    })().catch((e: unknown) => e)
    expect((err as ProviderError).code).toBe('aborted')
    expect(seen).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.requests[0]!.closedEarly).toBe(true)
  })
})

describe('cost estimate', () => {
  it('prices a cold and a warm question', () => {
    const c = estimateCost('claude-sonnet-5-5', 27_000, 1000, 1000, '5m')!
    expect(c.cold).toBeCloseTo(0.0795, 4)
    expect(c.warm).toBeCloseTo(0.0174, 4)
    expect(estimateCost('claude-unknown', 1, 1, 1, '5m')).toBeNull()
  })
})
