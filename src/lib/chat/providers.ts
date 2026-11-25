import { readWorkspaceSecret } from '../env.js'
import { CLI_SPECS, createCliProvider } from './cli-provider.js'
import { ANTHROPIC_KEY_ENV, type ChatConfig, type ChatProviderId } from './config.js'
import {
  createAnthropicProvider,
  type AnswerProvider,
  type Availability,
  type Billing,
} from './provider.js'

/**
 * The three answer backends (ADR 0005, "Providers"). Only the API provider uses the cached prompt
 * prefix; the CLI providers resend the whole prompt each time and are slower, but bill the user's
 * subscription and need no API key.
 */
export const PROVIDER_INFO: Readonly<
  Record<ChatProviderId, { label: string; billing: Billing; cached: boolean; vendor: string }>
> = {
  'anthropic-api': { label: 'Anthropic API', billing: 'api', cached: true, vendor: 'Anthropic' },
  'claude-cli': {
    label: CLI_SPECS['claude-cli'].label,
    billing: 'subscription',
    cached: false,
    vendor: 'Anthropic',
  },
  'cursor-cli': {
    label: CLI_SPECS['cursor-cli'].label,
    billing: 'subscription',
    cached: false,
    vendor: 'Cursor',
  },
}

export type ChatSummary = {
  enabled: boolean
  provider: ChatProviderId
  model: string
  billing: Billing
  /** Whether the provider can answer (no secrets: key present, CLI installed and logged in). */
  availability: Availability
}

/** One line for a terminal: provider, model, billing and what is missing, if anything. */
export function describeChat(c: ChatSummary): string {
  if (!c.enabled) return 'Q&A chat: off'
  const billing = c.billing === 'subscription' ? 'subscription, uncached' : 'API key, cached prompt'
  const head = `Q&A chat: ${c.provider} (${c.model}; ${billing})`
  return c.availability.state === 'ready'
    ? head
    : `${head}, not ready: ${c.availability.message ?? c.availability.state}; the panel will say so`
}

export type ProviderSourceOptions = {
  courseDir: string
  chat: ChatConfig
  env?: NodeJS.ProcessEnv
  /** Tests inject a provider. */
  provider?: AnswerProvider
  /** Builds the API provider for a key (default: the Anthropic SDK). */
  providerFactory?: (apiKey: string, chat: ChatConfig) => Promise<AnswerProvider>
  /** CLI providers: root for the private temp directories. */
  tmpDir?: string
}

/** Builds (and reuses) the configured provider and reports whether it can answer, without secrets. */
export class ProviderSource {
  private api: { key: string; provider: AnswerProvider } | null = null
  private cli: AnswerProvider | null = null
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly o: ProviderSourceOptions) {
    this.env = o.env ?? process.env
  }

  get id(): ChatProviderId {
    return this.o.chat.provider
  }

  get billing(): Billing {
    return this.o.provider?.billing ?? PROVIDER_INFO[this.id].billing
  }

  /** The workspace Anthropic key (for the API provider, and for redaction in any case). */
  apiKey(): string | null {
    return readWorkspaceSecret(this.o.courseDir, ANTHROPIC_KEY_ENV, this.env)
  }

  /** The provider, or null when the API provider has no key. */
  async get(): Promise<AnswerProvider | null> {
    if (this.o.provider) return this.o.provider
    const chat = this.o.chat
    if (chat.provider !== 'anthropic-api') {
      this.cli ??= createCliProvider({
        provider: chat.provider,
        model: chat.model,
        timeoutMs: chat.cliTimeoutMs,
        maxOutputBytes: chat.cliMaxOutputBytes,
        maxOutputTokens: chat.maxOutputTokens,
        env: this.env,
        tmpDir: this.o.tmpDir,
      })
      return this.cli
    }
    const key = this.apiKey()
    if (!key) return null
    if (this.api?.key !== key) {
      const factory =
        this.o.providerFactory ??
        ((k: string, cfg: ChatConfig) =>
          createAnthropicProvider({
            apiKey: k,
            model: cfg.model,
            refusalFallback: cfg.refusalFallback,
          }))
      this.api = { key, provider: await factory(key, chat) }
    }
    return this.api.provider
  }

  async availability(): Promise<Availability> {
    if (this.o.provider) {
      return this.o.provider.check ? this.o.provider.check() : { state: 'ready', message: null }
    }
    if (this.id === 'anthropic-api') {
      return this.apiKey()
        ? { state: 'ready', message: null }
        : {
            state: 'no-key',
            message: `${ANTHROPIC_KEY_ENV} is not set (put it in the workspace .env, next to course.json)`,
          }
    }
    const p = await this.get()
    return p!.check!()
  }
}
