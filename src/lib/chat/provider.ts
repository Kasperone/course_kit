import type Anthropic from '@anthropic-ai/sdk'
import { redactSecrets } from '../env.js'
import type { Effort } from './config.js'

/**
 * An answer backend. The server only needs a stream of answer text and, at the end, why it
 * stopped and the token usage (counts only; never logged with content).
 */
export type AnswerUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type AnswerEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; stopReason: string; usage: AnswerUsage; model: string }

export type AnswerRequest = {
  system: Anthropic.Beta.BetaTextBlockParam[]
  messages: Anthropic.Beta.BetaMessageParam[]
  maxTokens: number
  effort: Effort
}

/** How answers are paid for: per token (API key) or by the user's CLI subscription. */
export type Billing = 'api' | 'subscription'

/**
 * Whether a provider can answer right now. No secrets: CLI providers only report whether the CLI
 * is installed and logged in.
 */
export type ProviderState = 'ready' | 'no-key' | 'not-installed' | 'not-logged-in' | 'error'
export type Availability = { state: ProviderState; message: string | null }

export interface AnswerProvider {
  readonly id: string
  readonly model: string
  readonly billing: Billing
  answer(req: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent>
  /** Cheap readiness check (CLI providers: installed and logged in; cached briefly). */
  check?(): Promise<Availability>
}

export type ProviderErrorCode =
  | 'auth'
  | 'offline'
  | 'rate-limited'
  | 'overloaded'
  | 'bad-request'
  | 'aborted'
  | 'upstream'
  | 'unavailable'
  | 'not-logged-in'
  | 'timeout'
  | 'cut-off'

/** A provider failure with a stable code and a message that never contains a key. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODEL_RE = /^claude-(?:fable-5|mythos-5|opus-5|sonnet-5-5)/
export const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export function supportsRefusalFallback(model: string): boolean {
  return FALLBACK_MODEL_RE.test(model)
}

export type AnthropicOptions = {
  apiKey: string
  model: string
  refusalFallback: boolean
  /** Tests point this at a local mock server. */
  baseURL?: string
  maxRetries?: number
  timeoutMs?: number
}

/** Map an SDK error to a ProviderError (typed classes, most specific first). */
function toProviderError(
  err: unknown,
  sdk: typeof Anthropic,
  apiKey: string,
  aborted: boolean,
): ProviderError {
  const msg = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e), [apiKey])
  if (aborted || err instanceof sdk.APIUserAbortError)
    return new ProviderError('aborted', 'aborted')
  if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) {
    return new ProviderError('auth', 'The Anthropic API rejected the key (check ANTHROPIC_API_KEY)')
  }
  if (err instanceof sdk.RateLimitError) {
    return new ProviderError('rate-limited', 'The Anthropic API rate limit was reached')
  }
  if (err instanceof sdk.APIConnectionError) {
    return new ProviderError('offline', `Cannot reach the Anthropic API: ${msg(err)}`)
  }
  if (err instanceof sdk.BadRequestError) {
    return new ProviderError('bad-request', `The Anthropic API refused the request: ${msg(err)}`)
  }
  if (err instanceof sdk.APIError) {
    const status = err.status
    return new ProviderError(
      status === 529 ? 'overloaded' : 'upstream',
      `Anthropic API error${status ? ` ${status}` : ''}: ${msg(err)}`,
    )
  }
  return new ProviderError('upstream', msg(err))
}

/**
 * Claude via the official SDK (loaded only when the chat is used). Streams text deltas with
 * adaptive thinking (thinking text is not shown), the configured effort and, where the model
 * supports it, the server-side refusal fallback.
 */
export async function createAnthropicProvider(options: AnthropicOptions): Promise<AnswerProvider> {
  const { default: Sdk } = await import('@anthropic-ai/sdk')
  const client = new Sdk({
    apiKey: options.apiKey,
    // Only the workspace key: never an ANTHROPIC_AUTH_TOKEN or `ant` profile from elsewhere.
    authToken: null,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 120_000,
  })
  const fallback = options.refusalFallback && supportsRefusalFallback(options.model)
  return {
    id: 'anthropic-api',
    model: options.model,
    billing: 'api',
    async *answer(req, signal) {
      let stream
      try {
        stream = client.beta.messages.stream(
          {
            model: options.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: req.messages,
            thinking: { type: 'adaptive' },
            output_config: { effort: req.effort },
            ...(fallback ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          },
          { signal },
        )
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          }
        }
        const final = await stream.finalMessage()
        yield {
          type: 'done',
          stopReason: final.stop_reason ?? 'end_turn',
          model: final.model,
          usage: {
            input: final.usage.input_tokens,
            output: final.usage.output_tokens,
            cacheRead: final.usage.cache_read_input_tokens ?? 0,
            cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
          },
        }
      } catch (err) {
        throw toProviderError(err, Sdk, options.apiKey, signal.aborted)
      }
    },
  }
}

/** USD per million tokens (from Anthropic's price list; used only for estimates). */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}

/** Cost of one answer from its reported usage (null for unknown models). */
export function usageCost(model: string, usage: AnswerUsage, ttl: '5m' | '1h'): number | null {
  const p = PRICES[model]
  if (!p) return null
  const write = p.input * (ttl === '1h' ? 2 : 1.25)
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * write) /
    1_000_000
  )
}

/** Estimated cost of one question: cold (cache write) and warm (cache read). */
export function estimateCost(
  model: string,
  cachedTokens: number,
  otherTokens: number,
  outputTokens: number,
  ttl: '5m' | '1h',
): { cold: number; warm: number } | null {
  const p = PRICES[model]
  if (!p) return null
  const M = 1_000_000
  const write = p.input * (ttl === '1h' ? 2 : 1.25)
  const rest = (otherTokens * p.input + outputTokens * p.output) / M
  return {
    cold: (cachedTokens * write) / M + rest,
    warm: (cachedTokens * p.cacheRead) / M + rest,
  }
}
