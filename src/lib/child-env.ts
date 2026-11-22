/**
 * Environment for child processes course_kit starts (git, and in later steps jdeps and Slidev).
 *
 * An allowlist, not a denylist: API keys (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, any `*_TOKEN`) can
 * sit in the same shell as the user's `course` commands, and anything a child runs (git hooks and
 * credential helpers, Slidev plugins, workspace `vite.config.*`) would otherwise see them. Only
 * variables that processes need to find their tools, home, locale, terminal, proxy and ssh agent
 * pass through; `GIT_TERMINAL_PROMPT=0` makes git fail instead of prompting for a password.
 */

const ALLOWED_NAMES = new Set([
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
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  // Windows
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  // Network and ssh (git fetch in submodule mode, package managers)
  'SSH_AUTH_SOCK',
  // Which git config files apply (also how tests isolate git from the developer's configuration)
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
])

const ALLOWED_PREFIXES = ['LC_', 'XDG_']

/**
 * Names that look like credentials are dropped even when an `extra` entry would allow them: a
 * known suffix (`GITHUB_TOKEN`, `DBPASSWORD`), or a whole `_`-separated word that names a secret
 * (`SLIDEV_SECRET_KEY`, `VITE_DB_PASS`, `VITE_TOKEN_VALUE`, `X_PRIVATE_KEY`).
 */
const SECRET_NAME_RE = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i
const SECRET_WORDS = new Set([
  'KEY',
  'KEYS',
  'PASS',
  'PASSWORD',
  'PASSWD',
  'PWD',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'TOKENS',
  'CREDENTIAL',
  'CREDENTIALS',
  'PRIVATE',
  'APIKEY',
])

function looksSecret(name: string): boolean {
  return (
    SECRET_NAME_RE.test(name) ||
    name
      .toUpperCase()
      .split('_')
      .some((w) => SECRET_WORDS.has(w))
  )
}

export type ChildEnvOptions = {
  /** Source environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /**
   * Further variable names to keep, case-insensitive; a trailing `*` keeps a whole prefix
   * (e.g. `NODE_*`). Credential-looking names are still dropped.
   */
  extra?: string[]
}

export function childEnv(options: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const source = options.env ?? process.env
  const names = new Set((options.extra ?? []).filter((n) => !n.endsWith('*')).map(upper))
  const prefixes = [
    ...ALLOWED_PREFIXES,
    ...(options.extra ?? []).filter((n) => n.endsWith('*')).map((n) => upper(n.slice(0, -1))),
  ]
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const key = upper(name)
    const allowed =
      ALLOWED_NAMES.has(key) || names.has(key) || prefixes.some((p) => key.startsWith(p))
    // Proxy variables are also read in lower case (`https_proxy`), and are not credentials.
    if (allowed && !looksSecret(name)) out[name] = value
  }
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

function upper(s: string): string {
  return s.toUpperCase()
}
