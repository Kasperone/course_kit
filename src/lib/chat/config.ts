import { isPlainObject } from '../validate.js'

/**
 * course.json "chat": settings for the local Q&A backend (ADR 0005). Every field is optional;
 * `resolveChatConfig` fills in the defaults. The model can also come from the CLI (`--model`) or
 * the COURSE_CHAT_MODEL environment variable: flag > environment > course.json > default.
 */

export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5-5'
export const CHAT_MODEL_ENV = 'COURSE_CHAT_MODEL'
export const ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY'
export const DEFAULT_SERVE_PORT = 8787

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export const CACHE_TTLS = ['5m', '1h'] as const
export type CacheTtl = (typeof CACHE_TTLS)[number]
export const STT_PROVIDERS = ['whisper', 'elevenlabs', 'off'] as const
export type SttProviderId = (typeof STT_PROVIDERS)[number]

/** As written in course.json (validated; kept verbatim so `course pin` preserves it). */
export type ChatSettings = {
  enabled?: boolean
  model?: string
  effort?: Effort
  maxOutputTokens?: number
  maxPackTokens?: number
  historyTurns?: number
  cacheTtl?: CacheTtl
  refusalFallback?: boolean
  rateLimit?: { perMinute?: number; perDay?: number; concurrent?: number }
  port?: number
  stt?: { provider?: SttProviderId; model?: string }
}

export type ChatConfig = {
  enabled: boolean
  model: string
  effort: Effort
  maxOutputTokens: number
  maxPackTokens: number
  /** Cap for the deck-language slides and notes. */
  maxSlidesTokens: number
  /** Hard cap for the whole prompt (system + history + question). */
  maxPromptTokens: number
  historyTurns: number
  /** Characters per history entry. */
  maxHistoryChars: number
  maxQuestionChars: number
  cacheTtl: CacheTtl
  refusalFallback: boolean
  rateLimit: { perMinute: number; perDay: number; concurrent: number }
  port: number
  stt: { provider: SttProviderId; model: string | null }
  maxAudioSeconds: number
}

const DEFAULTS: ChatConfig = {
  enabled: true,
  model: DEFAULT_CHAT_MODEL,
  effort: 'low',
  maxOutputTokens: 8000,
  maxPackTokens: 60_000,
  maxSlidesTokens: 20_000,
  maxPromptTokens: 100_000,
  historyTurns: 6,
  maxHistoryChars: 4000,
  maxQuestionChars: 2000,
  cacheTtl: '5m',
  refusalFallback: true,
  rateLimit: { perMinute: 6, perDay: 200, concurrent: 1 },
  port: DEFAULT_SERVE_PORT,
  stt: { provider: 'whisper', model: null },
  maxAudioSeconds: 60,
}

export const CHAT_DEFAULTS: Readonly<ChatConfig> = Object.freeze(DEFAULTS)

/** Claude model ids: `claude-` plus lowercase letters, digits and hyphens (no URL characters). */
export const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9-]{0,59}$/

export function validateModelId(id: unknown, what = 'model'): string {
  if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) {
    throw new Error(
      `${what} must be a Claude model id such as "${DEFAULT_CHAT_MODEL}", got ${JSON.stringify(id)}`,
    )
  }
  return id
}

function int(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what} must be an integer from ${min} to ${max}`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, list: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    throw new Error(`${what} must be one of: ${list.join(', ')}`)
  }
  return value as T
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what} must be true or false`)
  return value
}

function knownKeys(obj: Record<string, unknown>, keys: string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw new Error(`${what}: unknown field "${key}"`)
  }
}

/** Validate course.json "chat" (unknown fields are errors, so typos do not go unnoticed). */
export function parseChatSettings(raw: unknown, what: string): ChatSettings {
  if (!isPlainObject(raw)) throw new Error(`${what} must be an object`)
  knownKeys(
    raw,
    [
      'enabled',
      'model',
      'effort',
      'maxOutputTokens',
      'maxPackTokens',
      'historyTurns',
      'cacheTtl',
      'refusalFallback',
      'rateLimit',
      'port',
      'stt',
    ],
    what,
  )
  const out: ChatSettings = {}
  if (raw.enabled !== undefined) out.enabled = bool(raw.enabled, `${what}.enabled`)
  if (raw.model !== undefined) out.model = validateModelId(raw.model, `${what}.model`)
  if (raw.effort !== undefined) out.effort = oneOf(raw.effort, EFFORTS, `${what}.effort`)
  if (raw.maxOutputTokens !== undefined) {
    out.maxOutputTokens = int(raw.maxOutputTokens, `${what}.maxOutputTokens`, 1000, 64_000)
  }
  if (raw.maxPackTokens !== undefined) {
    out.maxPackTokens = int(raw.maxPackTokens, `${what}.maxPackTokens`, 1000, 400_000)
  }
  if (raw.historyTurns !== undefined) {
    out.historyTurns = int(raw.historyTurns, `${what}.historyTurns`, 0, 20)
  }
  if (raw.cacheTtl !== undefined) out.cacheTtl = oneOf(raw.cacheTtl, CACHE_TTLS, `${what}.cacheTtl`)
  if (raw.refusalFallback !== undefined) {
    out.refusalFallback = bool(raw.refusalFallback, `${what}.refusalFallback`)
  }
  if (raw.rateLimit !== undefined) {
    const rl = raw.rateLimit
    if (!isPlainObject(rl)) throw new Error(`${what}.rateLimit must be an object`)
    knownKeys(rl, ['perMinute', 'perDay', 'concurrent'], `${what}.rateLimit`)
    out.rateLimit = {}
    if (rl.perMinute !== undefined) {
      out.rateLimit.perMinute = int(rl.perMinute, `${what}.rateLimit.perMinute`, 1, 120)
    }
    if (rl.perDay !== undefined) {
      out.rateLimit.perDay = int(rl.perDay, `${what}.rateLimit.perDay`, 1, 10_000)
    }
    if (rl.concurrent !== undefined) {
      out.rateLimit.concurrent = int(rl.concurrent, `${what}.rateLimit.concurrent`, 1, 4)
    }
  }
  if (raw.port !== undefined) out.port = int(raw.port, `${what}.port`, 1024, 65535)
  if (raw.stt !== undefined) {
    const stt = raw.stt
    if (!isPlainObject(stt)) throw new Error(`${what}.stt must be an object`)
    knownKeys(stt, ['provider', 'model'], `${what}.stt`)
    out.stt = {}
    if (stt.provider !== undefined) {
      out.stt.provider = oneOf(stt.provider, STT_PROVIDERS, `${what}.stt.provider`)
    }
    if (stt.model !== undefined) {
      if (typeof stt.model !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(stt.model)) {
        throw new Error(`${what}.stt.model must be a model name such as "large-v3-turbo-q5_0"`)
      }
      out.stt.model = stt.model
    }
  }
  return out
}

export type ChatOverrides = { model?: string; port?: number }

/** Defaults < course.json < COURSE_CHAT_MODEL < CLI flags. */
export function resolveChatConfig(
  settings: ChatSettings | undefined,
  overrides: ChatOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ChatConfig {
  const s = settings ?? {}
  const envModel = env[CHAT_MODEL_ENV]?.trim()
  const model =
    overrides.model !== undefined
      ? validateModelId(overrides.model, '--model')
      : envModel
        ? validateModelId(envModel, CHAT_MODEL_ENV)
        : (s.model ?? CHAT_DEFAULTS.model)
  return {
    ...CHAT_DEFAULTS,
    enabled: s.enabled ?? CHAT_DEFAULTS.enabled,
    model,
    effort: s.effort ?? CHAT_DEFAULTS.effort,
    maxOutputTokens: s.maxOutputTokens ?? CHAT_DEFAULTS.maxOutputTokens,
    maxPackTokens: s.maxPackTokens ?? CHAT_DEFAULTS.maxPackTokens,
    historyTurns: s.historyTurns ?? CHAT_DEFAULTS.historyTurns,
    cacheTtl: s.cacheTtl ?? CHAT_DEFAULTS.cacheTtl,
    refusalFallback: s.refusalFallback ?? CHAT_DEFAULTS.refusalFallback,
    rateLimit: { ...CHAT_DEFAULTS.rateLimit, ...s.rateLimit },
    port:
      overrides.port !== undefined
        ? int(overrides.port, '--port', 1, 65535)
        : (s.port ?? CHAT_DEFAULTS.port),
    stt: { ...CHAT_DEFAULTS.stt, ...s.stt },
  }
}
