import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { redactUrlCredentials } from '../context-pack/redact.js'
import { isPlainObject } from '../validate.js'
import { redactSecrets, SECRET_ENV_NAMES } from '../env.js'
import type { CliProviderId, Effort } from './config.js'
import { cursorWorkspaceDir, ensureCursorWorkspace } from './cursor-workspace.js'
import { flattenMessages, systemText } from './prompt.js'
import {
  ProviderError,
  type AnswerEvent,
  type AnswerProvider,
  type AnswerUsage,
  type Availability,
} from './provider.js'

/**
 * Chat answers from a subscription-backed CLI (ADR 0005, "Providers"): Claude Code (`claude -p`)
 * or the Cursor agent (`cursor-agent -p`). The CLI is only ever an external process:
 *
 * - `spawn` with an argument array (no shell); the executable is an absolute path from
 *   CLAUDE_BIN / CURSOR_AGENT_BIN or an absolute PATH entry;
 * - the prompt goes through stdin (Claude Code: the system prompt through a 0600 file in a private
 *   0700 temp directory), never through argv; the directory is removed afterwards;
 * - the working directory is an empty directory, never the repository or the workspace: a private
 *   temp directory, or for Cursor one stable empty directory in the user's cache (its transcripts
 *   would otherwise pile up in ~/.cursor/projects; `course clean` removes them);
 * - no tools (Cursor: ask mode plus a deny-all project permission file) and no permission-skipping
 *   flags; read-only / ask modes only;
 * - a hard timeout and an output cap, after which the whole process group is killed;
 * - provider keys (ANTHROPIC_*, ELEVENLABS_*) are removed from the child's environment.
 */

/**
 * Permission-skipping or auto-approving flags: never passed to a CLI (tests check every argument
 * list, and that `--permission-mode` is `dontAsk` and `--sandbox` is `enabled`).
 */
export const FORBIDDEN_CLI_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--force',
  '-f',
  '--yolo',
  '--auto-review',
  '--approve-mcps',
] as const

type ArgsInput = {
  model: string
  effort: Effort
  /** Claude Code: the system prompt file; null for CLIs that take everything on stdin. */
  systemFile: string | null
  /** The empty working directory. */
  workDir: string
}

type CliEvent =
  | { type: 'text'; text: string }
  | { type: 'model'; model: string }
  | {
      type: 'result'
      ok: boolean
      text: string
      stopReason: string | null
      usage: AnswerUsage | null
    }

interface StreamParser {
  line(obj: Record<string, unknown>): CliEvent[]
}

export type CliSpec = {
  id: CliProviderId
  label: string
  /** Executable name looked up on PATH. */
  command: string
  /** Absolute path override. */
  binEnv: string
  loginCommand: string
  statusArgs: string[]
  /** true/false from the CLI's JSON login status; null when it cannot be read. */
  loggedIn(status: unknown): boolean | null
  /** Claude Code takes the system prompt as a file; others get everything on stdin. */
  usesSystemFile: boolean
  /** Run in one stable empty directory instead of a fresh temp directory per answer. */
  stableWorkspace: boolean
  args(input: ArgsInput): string[]
  /**
   * This CLI's own login and configuration variables, passed on besides `CLI_BASE_ENV` and
   * `CLI_NETWORK_ENV`. Names come from the CLI itself (its help, docs and the variables its code
   * reads); anything not listed never reaches it.
   */
  envNames: readonly string[]
  extraEnv(maxOutputTokens: number): Record<string, string>
  parser(): StreamParser
}

function textOf(message: unknown): string {
  if (!isPlainObject(message) || !Array.isArray(message.content)) return ''
  return message.content
    .map((b: unknown) =>
      isPlainObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '',
    )
    .join('')
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Usage in Anthropic (snake_case) or Cursor (camelCase) shape; null if absent. */
export function parseUsage(raw: unknown): AnswerUsage | null {
  if (!isPlainObject(raw)) return null
  return {
    input: num(raw.input_tokens ?? raw.inputTokens),
    output: num(raw.output_tokens ?? raw.outputTokens),
    cacheRead: num(raw.cache_read_input_tokens ?? raw.cacheReadTokens),
    cacheWrite: num(raw.cache_creation_input_tokens ?? raw.cacheWriteTokens),
  }
}

/**
 * `claude -p --output-format stream-json --verbose --include-partial-messages`: text arrives as
 * `stream_event` content_block_delta/text_delta lines; the `assistant` message repeats it (used
 * only when no deltas came); a final `result` line carries is_error, the full text and usage.
 */
export class ClaudeStreamParser implements StreamParser {
  private streamed = false

  line(o: Record<string, unknown>): CliEvent[] {
    if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') {
      return [{ type: 'model', model: o.model }]
    }
    if (o.type === 'stream_event' && isPlainObject(o.event)) {
      const e = o.event
      if (
        e.type === 'content_block_delta' &&
        isPlainObject(e.delta) &&
        e.delta.type === 'text_delta' &&
        typeof e.delta.text === 'string'
      ) {
        this.streamed = true
        return [{ type: 'text', text: e.delta.text }]
      }
      return []
    }
    if (o.type === 'assistant') {
      if (this.streamed) return []
      const text = textOf(o.message)
      if (!text) return []
      this.streamed = true
      return [{ type: 'text', text }]
    }
    if (o.type === 'result') {
      return [
        {
          type: 'result',
          ok: o.is_error !== true && (o.subtype === undefined || o.subtype === 'success'),
          text: typeof o.result === 'string' ? o.result : '',
          stopReason: typeof o.stop_reason === 'string' ? o.stop_reason : null,
          usage: parseUsage(o.usage),
        },
      ]
    }
    return []
  }
}

/**
 * `cursor-agent -p --output-format stream-json --stream-partial-output`: each text delta is an
 * `assistant` line with `timestamp_ms`; the CLI then repeats the buffered text as an `assistant`
 * line without it (skipped once deltas were seen). A final `result` line ends the answer.
 */
export class CursorStreamParser implements StreamParser {
  private sawDelta = false

  line(o: Record<string, unknown>): CliEvent[] {
    if (o.type === 'system' && typeof o.model === 'string')
      return [{ type: 'model', model: o.model }]
    if (o.type === 'assistant') {
      const text = textOf(o.message)
      if (!text) return []
      if (o.timestamp_ms !== undefined) {
        this.sawDelta = true
        return [{ type: 'text', text }]
      }
      return this.sawDelta ? [] : [{ type: 'text', text }]
    }
    if (o.type === 'result') {
      return [
        {
          type: 'result',
          ok: o.is_error !== true && (o.subtype === undefined || o.subtype === 'success'),
          text: typeof o.result === 'string' ? o.result : '',
          stopReason: null,
          usage: parseUsage(o.usage),
        },
      ]
    }
    return []
  }
}

export const CLI_SPECS: Readonly<Record<CliProviderId, CliSpec>> = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude Code CLI',
    command: 'claude',
    binEnv: 'CLAUDE_BIN',
    loginCommand: 'claude auth login',
    statusArgs: ['auth', 'status', '--json'],
    loggedIn: (s) => (isPlainObject(s) && typeof s.loggedIn === 'boolean' ? s.loggedIn : null),
    usesSystemFile: true,
    stableWorkspace: false,
    args: ({ model, effort, systemFile }) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      model,
      '--effort',
      effort,
      // Our instructions and the lesson materials replace Claude Code's own system prompt.
      '--system-prompt-file',
      systemFile!,
      // No built-in tools, no MCP servers, and anything that would need a permission is denied.
      '--tools',
      '',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      // No user/project settings (hooks), CLAUDE.md, plugins, skills or slash commands.
      '--restricted',
      '--safe-mode',
      '--disable-slash-commands',
      '--no-session-persistence',
    ],
    // `claude setup-token` yields CLAUDE_CODE_OAUTH_TOKEN (a subscription token, not an API key);
    // logins stored by `claude auth login` live in CLAUDE_CONFIG_DIR (default ~/.claude).
    envNames: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'],
    extraEnv: (maxOutputTokens) => ({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }),
    parser: () => new ClaudeStreamParser(),
  },
  'cursor-cli': {
    id: 'cursor-cli',
    label: 'Cursor agent CLI',
    command: 'cursor-agent',
    binEnv: 'CURSOR_AGENT_BIN',
    loginCommand: 'cursor-agent login',
    statusArgs: ['status', '--format', 'json'],
    loggedIn: (s) =>
      isPlainObject(s) && typeof s.isAuthenticated === 'boolean' ? s.isAuthenticated : null,
    usesSystemFile: false,
    stableWorkspace: true,
    args: ({ model, workDir }) => [
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      // Read-only Q&A mode; never --force/--yolo, so nothing is written or run.
      '--mode',
      'ask',
      '--model',
      model,
      '--workspace',
      workDir,
      // Headless runs need the workspace trusted: this trusts only the one workspace directory, which
      // ensureCursorWorkspace() has checked to hold nothing but our deny-all .cursor/cli.json.
      '--trust',
      '--sandbox',
      'enabled',
    ],
    // `cursor-agent --help`: --api-key / CURSOR_API_KEY, -e / CURSOR_API_ENDPOINT; the agent also reads
    // CURSOR_AUTH_TOKEN, CURSOR_CONFIG_DIR, CURSOR_DATA_DIR and the XDG directories for its login.
    envNames: [
      'CURSOR_API_KEY',
      'CURSOR_AUTH_TOKEN',
      'CURSOR_API_ENDPOINT',
      'CURSOR_CONFIG_DIR',
      'CURSOR_DATA_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
    ],
    extraEnv: () => ({}),
    parser: () => new CursorStreamParser(),
  },
}

/**
 * What every CLI child gets: where to find programs and the home directory (OAuth logins are
 * stored in config files below it), user name, locale, time zone, temp directories and terminal
 * type, plus the Windows basics.
 */
const CLI_BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'NO_COLOR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]
const CLI_BASE_PREFIXES = ['LC_']

/**
 * Both CLIs talk to their vendor over HTTPS, so proxy and CA-certificate settings must pass for
 * them to work behind a corporate proxy (their code reads exactly these). `NODE_TLS_REJECT_UNAUTHORIZED`
 * is deliberately absent: it would switch certificate checks off.
 */
const CLI_NETWORK_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]

/**
 * An allowlisted copy of `env` for a CLI child: the base and network variables above and the CLI's
 * own login and configuration variables (`spec.envNames`), nothing else. So `GITHUB_TOKEN`,
 * `ELEVENLABS_API_KEY`, cloud credentials and every other variable of the user's shell stay in this
 * process, and a provider key (`ANTHROPIC_*`: it would also switch Claude Code to API billing) never
 * passes whatever a list says. Names match case-insensitively (Windows) and keep their spelling.
 */
export function cliChildEnv(
  env: NodeJS.ProcessEnv,
  spec: Pick<CliSpec, 'envNames'>,
): NodeJS.ProcessEnv {
  const allowed = new Set(
    [...CLI_BASE_ENV, ...CLI_NETWORK_ENV, ...spec.envNames].map((n) => n.toUpperCase()),
  )
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const key = name.toUpperCase()
    if (!allowed.has(key) && !CLI_BASE_PREFIXES.some((p) => key.startsWith(p))) continue
    if (/^(?:ANTHROPIC|ELEVENLABS)_/i.test(name)) continue
    if ((SECRET_ENV_NAMES as readonly string[]).includes(key)) continue
    out[name] = value
  }
  return out
}

/**
 * The values of the credentials a CLI is deliberately given (`CLAUDE_CODE_OAUTH_TOKEN`,
 * `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`: the token-like names in its `envNames`). A CLI's error text
 * can echo them, and it ends up in the panel, so every CLI message is redacted with these.
 */
export function cliSecretValues(env: NodeJS.ProcessEnv, spec: Pick<CliSpec, 'envNames'>): string[] {
  const names = new Set(
    spec.envNames.filter((n) => /KEY|TOKEN|SECRET|PASSWORD/i.test(n)).map((n) => n.toUpperCase()),
  )
  return Object.entries(env)
    .filter(([name, value]) => names.has(name.toUpperCase()) && value)
    .map(([, value]) => value as string)
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** First executable `name` in an absolute PATH entry (relative entries are ignored). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    for (const n of names) {
      const file = path.join(dir, n)
      if (isExecutableFile(file)) return file
    }
  }
  return null
}

/** The CLI's absolute path, or why it cannot be used. */
export function resolveCliBin(
  spec: CliSpec,
  env: NodeJS.ProcessEnv,
): { bin: string } | { problem: string } {
  const override = env[spec.binEnv]?.trim()
  if (override) {
    if (!path.isAbsolute(override)) return { problem: `${spec.binEnv} must be an absolute path` }
    if (!isExecutableFile(override)) {
      return { problem: `${spec.binEnv} (${override}) is not an executable file` }
    }
    return { bin: override }
  }
  const bin = findOnPath(spec.command, env)
  return bin
    ? { bin }
    : {
        problem: `${spec.label} (\`${spec.command}\`) is not installed or not on PATH; install it or set ${spec.binEnv}`,
      }
}

/** Live CLI process groups, killed if this process exits while they run. */
const live = new Set<ChildProcess>()
let exitHook = false

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') child.kill(sig)
    else process.kill(-pid, sig)
  } catch {
    // already gone
  }
}

/** SIGTERM the whole process group, SIGKILL it 2 s later. */
function killGroup(child: ChildProcess): void {
  signalGroup(child, 'SIGTERM')
  setTimeout(() => signalGroup(child, 'SIGKILL'), 2000).unref()
}

export type RunOptions = {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin: string
  timeoutMs: number
  maxStdoutBytes: number
  signal?: AbortSignal
  label: string
}

export type RunOutcome = { code: number | null; signal: NodeJS.Signals | null; stderr: string }

const STDERR_CAP = 16 * 1024

/**
 * Run a CLI and yield its stdout line by line; returns the exit status and (capped) stderr. A
 * timeout, an abort or too much output kills the process group and throws a ProviderError.
 */
export async function* runCliLines(o: RunOptions): AsyncGenerator<string, RunOutcome> {
  const child = spawn(o.bin, o.args, {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    // Its own process group, so a kill also reaches anything the CLI started.
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  live.add(child)
  if (!exitHook) {
    exitHook = true
    process.once('exit', () => {
      for (const c of live) signalGroup(c, 'SIGKILL')
    })
  }
  const lines: string[] = []
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let stdoutBytes = 0
  let stderr = ''
  let failure: ProviderError | null = null
  let exited: RunOutcome | null = null
  let wake: (() => void) | null = null
  const notify = () => {
    const w = wake
    wake = null
    w?.()
  }
  const fail = (err: ProviderError) => {
    failure ??= err
    if (!exited) killGroup(child)
    notify()
  }
  const timer = setTimeout(
    () =>
      fail(
        new ProviderError(
          'timeout',
          `${o.label} did not answer within ${Math.round(o.timeoutMs / 1000)} s (stopped)`,
        ),
      ),
    o.timeoutMs,
  )
  const onAbort = () => fail(new ProviderError('aborted', 'aborted'))
  if (o.signal?.aborted) onAbort()
  else o.signal?.addEventListener('abort', onAbort, { once: true })

  child.stdout!.on('data', (buf: Buffer) => {
    stdoutBytes += buf.length
    if (stdoutBytes > o.maxStdoutBytes) {
      fail(
        new ProviderError(
          'cut-off',
          `${o.label} wrote more than ${Math.round(o.maxStdoutBytes / 1024)} KB of output (stopped)`,
        ),
      )
      return
    }
    pending += decoder.write(buf)
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      lines.push(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
    notify()
  })
  child.stderr!.on('data', (buf: Buffer) => {
    if (stderr.length < STDERR_CAP)
      stderr += buf.toString('utf8').slice(0, STDERR_CAP - stderr.length)
  })
  child.on('error', (err: NodeJS.ErrnoException) => {
    fail(
      err.code === 'ENOENT' || err.code === 'EACCES'
        ? new ProviderError('unavailable', `${o.label} could not be started (${err.code})`)
        : new ProviderError('upstream', `${o.label} could not be started: ${err.message}`),
    )
  })
  child.on('close', (code, sig) => {
    // Anything the CLI left running in its group (cursor-agent starts a per-workspace
    // `worker-server` that outlives it) is ended too: the workspace was ours and is about to go.
    signalGroup(child, 'SIGTERM')
    pending += decoder.end()
    if (pending) lines.push(pending)
    pending = ''
    exited = { code, signal: sig, stderr }
    live.delete(child)
    notify()
  })
  // The CLI may exit before reading all of stdin (EPIPE); its exit status tells what happened.
  child.stdin!.on('error', () => {})
  child.stdin!.end(o.stdin)

  try {
    for (;;) {
      if (failure) throw failure
      if (lines.length > 0) {
        yield lines.shift()!
        continue
      }
      if (exited) return exited
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
    if (!exited) killGroup(child)
  }
}

/** A private (0700) temp directory with an empty `cwd/` subdirectory; remove it when done. */
export async function privateWorkDir(root: string): Promise<{ dir: string; work: string }> {
  const dir = await mkdtemp(path.join(root, 'course-chat-'))
  const work = path.join(dir, 'cwd')
  await mkdir(work, { mode: 0o700 })
  return { dir, work }
}

/** The one stable workspace of a CLI that needs it; an unusable or non-empty directory is "unavailable". */
function stableWorkspace(env: NodeJS.ProcessEnv): string {
  try {
    return ensureCursorWorkspace(cursorWorkspaceDir(env))
  } catch (err) {
    throw new ProviderError('unavailable', `Cursor workspace: ${(err as Error).message}`)
  }
}

/** First non-empty line of a CLI's output, for an error message: URL passwords (proxies) dropped, then cut. */
const firstLine = (text: string): string =>
  (
    redactUrlCredentials(text)
      .split(/\r?\n/)
      .find((l) => l.trim()) ?? ''
  )
    .trim()
    .slice(0, 300)

/** Map a CLI failure text to a ProviderError with an actionable message (no secrets: CLIs print none). */
export function classifyCliFailure(
  spec: CliSpec,
  text: string,
  code?: number | null,
): ProviderError {
  const t = text.trim()
  if (
    /not logged in|please run \/login|run .{0,20}login|unauthori[sz]ed|unauthenticated|authentication (?:required|failed)|invalid api key|(?:token|login) (?:has )?expired/i.test(
      t,
    )
  ) {
    return new ProviderError(
      'not-logged-in',
      `${spec.label} is not logged in (or the login expired): run \`${spec.loginCommand}\``,
    )
  }
  if (/usage limit|rate.?limit|too many requests|quota/i.test(t)) {
    return new ProviderError('rate-limited', `${spec.label}: usage limit reached (${firstLine(t)})`)
  }
  if (/unknown option|unknown argument|unexpected argument|invalid (?:option|argument)/i.test(t)) {
    return new ProviderError(
      'upstream',
      `${spec.label} rejected its arguments (is it up to date?): ${firstLine(t)}`,
    )
  }
  const exit = code !== undefined && code !== null ? ` (exit ${code})` : ''
  return new ProviderError(
    'upstream',
    `${spec.label} failed${exit}: ${firstLine(t) || 'no output'}`,
  )
}

export type CliProviderOptions = {
  provider: CliProviderId
  model: string
  timeoutMs: number
  maxOutputBytes: number
  /** Claude Code: CLAUDE_CODE_MAX_OUTPUT_TOKENS (Cursor has no such setting). */
  maxOutputTokens: number
  env?: NodeJS.ProcessEnv
  /** Where the private temp directories go (default: the OS temp directory). */
  tmpDir?: string
  /** How long a login-status result is reused (ready; failures for 5 s). */
  statusTtlMs?: number
  statusTimeoutMs?: number
}

/**
 * A CLI chat provider. Subscription-billed, uncached (each answer sends the whole prompt again)
 * and slower than the API, but needs no API key.
 */
export function createCliProvider(o: CliProviderOptions): AnswerProvider {
  const spec = CLI_SPECS[o.provider]
  const env = o.env ?? process.env
  const secrets = cliSecretValues(env, spec)
  const tmpRoot = o.tmpDir ?? os.tmpdir()
  const statusTtl = o.statusTtlMs ?? 60_000
  let status: { at: number; value: Availability } | null = null

  async function readStatus(bin: string): Promise<Availability> {
    const { dir, work } = await privateWorkDir(tmpRoot)
    try {
      let out = ''
      const run = runCliLines({
        bin,
        args: spec.statusArgs,
        cwd: work,
        env: cliChildEnv(env, spec),
        stdin: '',
        timeoutMs: o.statusTimeoutMs ?? 15_000,
        maxStdoutBytes: 64 * 1024,
        label: spec.label,
      })
      let r = await run.next()
      while (!r.done) {
        out += r.value + '\n'
        r = await run.next()
      }
      let json: unknown = null
      try {
        json = JSON.parse(out)
      } catch {
        // not JSON
      }
      const loggedIn = spec.loggedIn(json)
      if (loggedIn === true) return { state: 'ready', message: null }
      if (loggedIn === false) {
        return {
          state: 'not-logged-in',
          message: `${spec.label} is not logged in: run \`${spec.loginCommand}\``,
        }
      }
      return {
        state: 'error',
        message: `Could not read the login status of ${spec.label}: ${firstLine(redactSecrets(r.value.stderr, secrets)) || `exit ${r.value.code}`}`,
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : null
      return {
        state: pe?.code === 'unavailable' ? 'not-installed' : 'error',
        message: pe?.message ?? String(err),
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function check(): Promise<Availability> {
    const now = Date.now()
    if (status && now - status.at < (status.value.state === 'ready' ? statusTtl : 5_000)) {
      return status.value
    }
    const resolved = resolveCliBin(spec, env)
    const value =
      'problem' in resolved
        ? { state: 'not-installed' as const, message: resolved.problem }
        : await readStatus(resolved.bin)
    status = { at: Date.now(), value }
    return value
  }

  return {
    id: spec.id,
    model: o.model,
    billing: 'subscription',
    check,
    async *answer(req, signal): AsyncIterable<AnswerEvent> {
      const resolved = resolveCliBin(spec, env)
      if ('problem' in resolved) throw new ProviderError('unavailable', resolved.problem)
      const { dir, work: privateWork } = await privateWorkDir(tmpRoot)
      const run = { gen: null as AsyncGenerator<string, RunOutcome> | null }
      try {
        const work = spec.stableWorkspace ? stableWorkspace(env) : privateWork
        const system = systemText(req.system)
        const conversation = flattenMessages(req.messages)
        let systemFile: string | null = null
        if (spec.usesSystemFile) {
          systemFile = path.join(dir, 'system-prompt.md')
          await writeFile(systemFile, system, { mode: 0o600, flag: 'wx' })
        }
        const stdin = spec.usesSystemFile ? conversation : `${system}\n\n${conversation}`
        const parser = spec.parser()
        let model = o.model
        let streamed = false
        let result: Extract<CliEvent, { type: 'result' }> | null = null
        const other: string[] = []
        run.gen = runCliLines({
          bin: resolved.bin,
          args: spec.args({ model: o.model, effort: req.effort, systemFile, workDir: work }),
          cwd: work,
          env: { ...cliChildEnv(env, spec), ...spec.extraEnv(req.maxTokens) },
          stdin,
          timeoutMs: o.timeoutMs,
          maxStdoutBytes: o.maxOutputBytes,
          signal,
          label: spec.label,
        })
        let next = await run.gen.next()
        while (!next.done) {
          const line = next.value.trim()
          let obj: unknown = null
          if (line.startsWith('{')) {
            try {
              obj = JSON.parse(line)
            } catch {
              // not JSON
            }
          }
          if (isPlainObject(obj)) {
            for (const e of parser.line(obj)) {
              if (e.type === 'text') {
                streamed = true
                yield { type: 'text', text: e.text }
              } else if (e.type === 'model') model = e.model
              else result = e
            }
          } else if (line && other.length < 20) other.push(line)
          next = await run.gen.next()
        }
        const outcome = next.value
        if (result && !result.ok) {
          status = null
          throw classifyCliFailure(
            spec,
            redactSecrets(`${result.text}\n${outcome.stderr}`, secrets),
            outcome.code,
          )
        }
        if (!result) {
          status = null
          throw classifyCliFailure(
            spec,
            redactSecrets(`${outcome.stderr}\n${other.join('\n')}`, secrets),
            outcome.code,
          )
        }
        if (!streamed && result.text) yield { type: 'text', text: result.text }
        yield {
          type: 'done',
          stopReason: result.stopReason ?? 'end_turn',
          model,
          usage: result.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }
      } finally {
        await run.gen?.return(undefined as never)
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
