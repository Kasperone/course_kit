import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Secrets (API keys) for a course workspace. A key comes from the environment, else from the
 * workspace's gitignored `.env` next to course.json. Values are returned to the caller only: they
 * are never printed, logged, written to a file or sent to the browser.
 */

/** Environment variables that hold provider keys. Never passed on to child processes we start. */
export const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ELEVENLABS_API_KEY',
] as const

const NAME_RE = /^[A-Z][A-Z0-9_]*$/

/** `name` from the environment, else from `<courseDir>/.env`; null when unset or empty. */
export function readWorkspaceSecret(
  courseDir: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!NAME_RE.test(name)) throw new Error(`Invalid variable name ${JSON.stringify(name)}`)
  const fromEnv = env[name]?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(courseDir, '.env')
  if (!existsSync(file)) return null
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`)
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(re)
    if (!m) continue
    const value = m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim()
    if (value) return value
  }
  return null
}

/** Replace every occurrence of each secret, so none can leak through a message. */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('‹redacted›')
  return out
}

/** A copy of `env` without provider keys (for child processes such as Slidev). */
export function withoutSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const name of SECRET_ENV_NAMES) delete out[name]
  return out
}
