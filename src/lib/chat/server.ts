import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { CourseJson } from '../../commands/init.js'
import { redactSecrets } from '../env.js'
import { readJsonFile } from '../validate.js'
import { parseCourseJson } from '../workspace.js'
import type { ChatConfig } from './config.js'
import { LessonNotFoundError, loadLessonMaterials, type LessonMaterials } from './materials.js'
import {
  AskValidationError,
  buildMessages,
  buildSystem,
  materialsProblem,
  parseAskRequest,
  promptBudget,
  SourceSplitter,
  type PromptContext,
} from './prompt.js'
import { ProviderError, type AnswerProvider, type AnswerUsage } from './provider.js'
import { PROVIDER_INFO, ProviderSource, type ChatSummary } from './providers.js'
import { serveStatic } from './static.js'

/**
 * The local Q&A backend (ADR 0005). It listens on 127.0.0.1 only, serves the chat API under
 * /@course-chat/v1/ and, for `course serve`, the built decks from dist/, so the browser only ever
 * talks to one local origin. API keys stay in this process.
 */

export const API_PREFIX = '/@course-chat/'
export const API_BASE = '/@course-chat/v1/'
export const API_VERSION = 1
export const BIND_HOST = '127.0.0.1'
const MAX_JSON_BYTES = 32 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export type ChatServerOptions = {
  courseDir: string
  /** 0 picks a free port. */
  port: number
  /** null: the API answers `disabled` (course serve --no-chat, or chat.enabled false). */
  chat: ChatConfig | null
  /** Serve this directory (dist/) at /, next to the API. */
  staticDir?: string | null
  /** Tests inject a provider; otherwise the one chat.provider selects. */
  provider?: AnswerProvider
  /** Builds the anthropic-api provider for a key (default: the Anthropic SDK). */
  providerFactory?: (apiKey: string, chat: ChatConfig) => Promise<AnswerProvider>
  /** CLI providers: root for their private temp directories (default: the OS temp directory). */
  tmpDir?: string
  env?: NodeJS.ProcessEnv
  /** One line per request, without content or secrets. */
  log?: (line: string) => void
  now?: () => number
  heartbeatMs?: number
}

export type ChatServer = {
  url: string
  port: number
  /** Provider, model, billing and availability (null when the chat is disabled). */
  summary(): Promise<ChatSummary | null>
  close(): Promise<void>
}

/** Sliding one-minute window plus a per-day count (in memory, per server run). */
export class RateLimiter {
  private minute: number[] = []
  private day = ''
  private dayCount = 0

  constructor(
    private readonly perMinute: number,
    private readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take one slot, or say how many seconds to wait. */
  take(): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.now()
    const day = new Date(t).toISOString().slice(0, 10)
    if (day !== this.day) {
      this.day = day
      this.dayCount = 0
    }
    if (this.dayCount >= this.perDay) {
      const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000
      return { ok: false, retryAfter: Math.max(1, Math.ceil((midnight - t) / 1000)) }
    }
    this.minute = this.minute.filter((s) => t - s < 60_000)
    if (this.minute.length >= this.perMinute) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((this.minute[0]! + 60_000 - t) / 1000)),
      }
    }
    this.minute.push(t)
    this.dayCount++
    return { ok: true }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

/** Host header with a loopback name (defeats DNS rebinding), lowercased; null otherwise. */
export function loopbackHost(req: IncomingMessage): string | null {
  const host = req.headers.host?.toLowerCase()
  if (!host) return null
  const m = host.match(/^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/)
  return m && LOOPBACK_HOSTS.has(m[1]!) ? host : null
}

/**
 * Browser requests must come from the page this server (or the dev proxy in front of it) serves:
 * Origin, when present, must be exactly http://<Host>; POSTs must carry it. No CORS headers are
 * ever sent, so other origins can neither call nor read the API.
 */
export function originProblem(req: IncomingMessage, host: string): string | null {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return 'cross-site request'
  }
  const origin = req.headers.origin
  if (origin === undefined) return req.method === 'POST' ? 'Origin header required' : null
  return origin.toLowerCase() === `http://${host}` ? null : 'foreign Origin'
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'too-large', `Body over ${limit} bytes`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'too-large', `Body over ${limit} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function repoName(course: CourseJson): string {
  const from = course.targetRemote ?? course.targetRepo ?? ''
  const name = path.basename(from.replace(/\/+$/, '')).replace(/\.git$/, '')
  return name || 'the target repository'
}

export async function startChatServer(options: ChatServerOptions): Promise<ChatServer> {
  const { courseDir, chat } = options
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const limiter = chat
    ? new RateLimiter(chat.rateLimit.perMinute, chat.rateLimit.perDay, now)
    : null
  let inFlight = 0
  const source = chat
    ? new ProviderSource({
        courseDir,
        chat,
        env,
        provider: options.provider,
        providerFactory: options.providerFactory,
        tmpDir: options.tmpDir,
      })
    : null

  const course = (): CourseJson => {
    const file = path.join(courseDir, 'course.json')
    return parseCourseJson(readJsonFile(file, readFileSync(file, 'utf8')), file)
  }
  /** For redaction: the workspace Anthropic key, whatever the provider. */
  const secrets = () => [source?.apiKey() ?? null]

  function materialsFor(c: CourseJson, lesson: unknown, lang: unknown): LessonMaterials {
    if (typeof lesson !== 'string' || typeof lang !== 'string') {
      throw new HttpError(400, 'bad-request', 'lesson and lang are required')
    }
    try {
      return loadLessonMaterials(courseDir, c, lesson, lang, chat!.maxPackTokens)
    } catch (err) {
      if (err instanceof LessonNotFoundError) throw new HttpError(404, 'not-found', err.message)
      const msg = err instanceof Error ? err.message : String(err)
      throw new HttpError(400, 'bad-request', msg.replace(courseDir, '<workspace>'))
    }
  }

  function promptContext(c: CourseJson): PromptContext {
    return { repoName: repoName(c), pinnedCommit: c.pinnedCommit }
  }

  async function status(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const availability = source ? await source.availability() : null
    const info = chat ? PROVIDER_INFO[chat.provider] : null
    const base = {
      apiVersion: API_VERSION,
      answers: !availability
        ? 'disabled'
        : availability.state === 'ready'
          ? 'ready'
          : availability.state === 'no-key'
            ? 'no-key'
            : 'unavailable',
      provider: chat?.provider ?? null,
      providerState: availability?.state ?? null,
      providerMessage: availability?.message ?? null,
      billing: source?.billing ?? null,
      cachedPrompt: info?.cached ?? null,
      vendor: info?.vendor ?? null,
      model: chat?.model ?? null,
      stt: 'off',
      limits: chat
        ? {
            maxQuestionChars: chat.maxQuestionChars,
            historyTurns: chat.historyTurns,
            maxAudioSeconds: chat.maxAudioSeconds,
          }
        : null,
    }
    if (!chat) return sendJson(res, 200, { ...base, pack: null })
    const c = course()
    const m = materialsFor(c, url.searchParams.get('lesson'), url.searchParams.get('lang'))
    const problem = materialsProblem(m, chat)
    const system = buildSystem(m, promptContext(c), chat.cacheTtl)
    sendJson(res, 200, {
      ...base,
      lesson: m.lessonId,
      lang: m.lang,
      title: m.title,
      slides: m.slides.length,
      pack: problem?.code === 'too-large' ? 'too-large' : m.pack.status,
      problem: problem?.message ?? null,
      packCommit: m.pack.commit,
      pinnedCommit: c.pinnedCommit,
      promptTokens: promptBudget(system, []).systemTokens,
    })
  }

  async function ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!chat) throw new HttpError(503, 'disabled', 'The chat is disabled for this course')
    const type = req.headers['content-type'] ?? ''
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      throw new HttpError(415, 'bad-request', 'Content-Type must be application/json')
    }
    const raw = await readBody(req, MAX_JSON_BYTES)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'bad-request', 'Body is not valid JSON')
    }
    let q
    try {
      q = parseAskRequest(body, chat)
    } catch (err) {
      if (err instanceof AskValidationError) throw new HttpError(400, 'bad-request', err.message)
      throw err
    }
    const c = course()
    const m = materialsFor(c, q.lesson, q.lang)
    if (q.slide > m.slides.length) {
      throw new HttpError(400, 'bad-request', `slide must be from 1 to ${m.slides.length}`)
    }
    const problem = materialsProblem(m, chat)
    if (problem) throw new HttpError(422, problem.code, problem.message)
    const system = buildSystem(m, promptContext(c), chat.cacheTtl)
    const messages = buildMessages(q, m, chat.historyTurns)
    const budget = promptBudget(system, messages)
    if (budget.totalTokens > chat.maxPromptTokens) {
      throw new HttpError(
        413,
        'too-large',
        `The prompt (~${budget.totalTokens} tokens) is over ${chat.maxPromptTokens} tokens`,
      )
    }
    const availability = await source!.availability()
    if (availability.state !== 'ready') {
      const code =
        availability.state === 'no-key' || availability.state === 'not-logged-in'
          ? availability.state
          : 'unavailable'
      throw new HttpError(503, code, availability.message ?? 'The chat provider is not ready')
    }
    const p = await source!.get()
    if (!p) throw new HttpError(503, 'no-key', 'No API key')
    if (inFlight >= chat.rateLimit.concurrent) {
      throw new HttpError(429, 'busy', 'Another answer is still running', { 'Retry-After': '5' })
    }
    const slot = limiter!.take()
    if (!slot.ok) {
      throw new HttpError(429, 'rate-limited', 'Too many questions; try again later', {
        'Retry-After': String(slot.retryAfter),
      })
    }

    inFlight++
    const started = now()
    const ac = new AbortController()
    let finished = false
    res.on('close', () => {
      if (!finished) ac.abort()
    })
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    })
    const event = (name: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, heartbeatMs)
    const splitter = new SourceSplitter()
    const emit = (parts: ReturnType<SourceSplitter['feed']>) => {
      for (const part of parts) {
        if (part.type === 'off-topic') event('scope', { value: 'off-topic' })
        else event('delta', { text: part.text, source: part.source })
      }
    }
    let outcome = 'error'
    let usage: AnswerUsage | null = null
    try {
      event('start', {
        model: p.model,
        provider: source!.id,
        billing: p.billing,
        promptVersion: 1,
      })
      for await (const e of p.answer(
        { system, messages, maxTokens: chat.maxOutputTokens, effort: chat.effort },
        ac.signal,
      )) {
        if (e.type === 'text') {
          emit(splitter.feed(e.text))
          continue
        }
        emit(splitter.flush())
        usage = e.usage
        outcome = e.stopReason
        if (e.stopReason === 'refusal') {
          event('error', {
            code: 'refused',
            message: 'Claude declined to answer this question',
          })
        } else {
          event('done', { stopReason: e.stopReason, model: e.model, usage: e.usage })
        }
      }
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('upstream', err instanceof Error ? err.message : String(err))
      outcome = pe.code
      event('error', { code: pe.code, message: redactSecrets(pe.message, secrets()) })
    } finally {
      finished = true
      clearInterval(heartbeat)
      inFlight--
      res.end()
      const u = usage as AnswerUsage | null
      const tokens = u
        ? ` · in ${u.input} (cache read ${u.cacheRead}, write ${u.cacheWrite}) out ${u.output}`
        : ''
      const billing = p.billing === 'subscription' ? ' · subscription' : ''
      log(
        `ask ${q.lesson}/${q.lang} slide ${q.slide} · ${source!.id} ${p.model} · ${now() - started} ms${tokens}${billing} · ${outcome}`,
      )
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, host: string) {
    if (req.method === 'OPTIONS') {
      throw new HttpError(405, 'method', 'Cross-origin requests are not supported')
    }
    const problem = originProblem(req, host)
    if (problem) throw new HttpError(403, 'forbidden', problem)
    const route = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : null
    if (route === 'status' && (req.method === 'GET' || req.method === 'HEAD')) {
      return status(req, res, url)
    }
    if (route === 'ask' && req.method === 'POST') return ask(req, res)
    if (route === 'status' || route === 'ask') {
      throw new HttpError(405, 'method', 'Method not allowed')
    }
    throw new HttpError(404, 'not-found', 'Unknown API route')
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const host = loopbackHost(req)
    if (!host) {
      log(`403 ${req.method} (host not allowed)`)
      return sendJson(res, 403, { error: 'forbidden', message: 'Host not allowed' })
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith(API_PREFIX)) {
      api(req, res, url, host).catch((err: unknown) => {
        const e =
          err instanceof HttpError
            ? err
            : new HttpError(500, 'internal', err instanceof Error ? err.message : String(err))
        if (!(err instanceof HttpError))
          log(`500 ${url.pathname}: ${redactSecrets(e.message, secrets())}`)
        else if (e.status >= 400) log(`${e.status} ${req.method} ${url.pathname} (${e.code})`)
        if (res.headersSent) return void res.end()
        sendJson(
          res,
          e.status,
          { error: e.code, message: redactSecrets(e.message, secrets()) },
          e.headers,
        )
      })
      return
    }
    if (options.staticDir) return serveStatic(req, res, options.staticDir)
    sendJson(res, 404, { error: 'not-found', message: 'Not found' })
  }

  const server: Server = createServer(handler)
  // An idle keep-alive socket must not hold up shutdown; answers have their own timeout.
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${options.port} on ${BIND_HOST} is already in use (try --port)`)
          : err,
      ),
    )
    server.listen(options.port, BIND_HOST, () => resolve())
  })
  const { port } = server.address() as { port: number }
  return {
    url: `http://${BIND_HOST}:${port}`,
    port,
    summary: async () =>
      chat && source
        ? {
            enabled: true,
            provider: chat.provider,
            model: chat.model,
            billing: source.billing,
            availability: await source.availability(),
          }
        : null,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
