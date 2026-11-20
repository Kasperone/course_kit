/**
 * Line-preserving redaction of obvious secrets in text embedded in a context pack. It is a safety
 * net behind the path denylist (sensitive.ts), not a full secret scanner: it targets well-known
 * token formats, private key blocks, credentials in URLs, literal string assignments to
 * secret-looking names, and secret-looking keys in config files.
 */

export const REDACTED = '‹redacted›'

export type Redaction = { line: number; kind: string }

export type RedactionResult = { text: string; redactions: Redaction[] }

const TOKEN_PATTERNS: Array<[kind: string, re: RegExp]> = [
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g],
  ['api-key', /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
]

/** user:password@ in URLs (keep the user, drop the password). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi

const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_.-]*'

/** `password = "literal"` style assignments in any language (literal of 4+ chars). */
const LITERAL_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_NAME})(["']?\\s*[:=]\\s*)(["'\`])([^"'\`\\s]{4,})\\3`,
  'gi',
)

/** `key: value` / `key=value` lines in config files where the key looks secret. */
const CONFIG_LINE = new RegExp(
  `^(\\s*(?:-\\s+)?["']?)(${SECRET_NAME})(["']?\\s*[:=]\\s*)(.*)$`,
  'i',
)

const CONFIG_FILE = /(\.(properties|ya?ml|ini|cfg|conf|toml|json|env|xml)|(^|\/)\.env[^/]*)$/i

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/

function redactConfigValue(raw: string): string | null {
  const m = raw.match(/^(\s*)(["']?)(.*?)\2(\s*,?\s*)$/)
  if (!m) return null
  const [, lead, quote, inner, tail] = m as unknown as [string, string, string, string, string]
  const value = inner.trim()
  if (value === '' || /^(true|false|null|none|~|\{|\[|\|)$/i.test(value)) return null
  if (value.startsWith(REDACTED)) return null
  // ${ENV_VAR} placeholders carry no secret; ${ENV_VAR:default} may carry one in the default.
  const placeholder = value.match(/^\$\{([^}:]+)(?::(.*))?\}$/)
  if (placeholder) {
    if (!placeholder[2]) return null
    return `${lead}${quote}\${${placeholder[1]}:${REDACTED}}${quote}${tail}`
  }
  return `${lead}${quote}${REDACTED}${quote}${tail}`
}

export function redactSecrets(text: string, filePath: string): RedactionResult {
  const redactions: Redaction[] = []
  const isConfig = CONFIG_FILE.test(filePath)
  let inPem = false
  const lines = text.split('\n').map((line, i) => {
    const lineNo = i + 1
    if (inPem) {
      if (PEM_END.test(line)) {
        inPem = false
        return line
      }
      return REDACTED
    }
    if (PEM_BEGIN.test(line)) {
      inPem = !PEM_END.test(line)
      redactions.push({ line: lineNo, kind: 'private-key' })
      return line.replace(/(-----BEGIN [^-]+-----).*?(-----END [^-]+-----)?$/, (_m, b, e) =>
        e ? `${b}${REDACTED}${e}` : b,
      )
    }
    let out = line
    for (const [kind, re] of TOKEN_PATTERNS) {
      out = out.replace(re, () => {
        redactions.push({ line: lineNo, kind })
        return REDACTED
      })
    }
    out = out.replace(URL_CREDENTIALS, (_m, prefix: string) => {
      redactions.push({ line: lineNo, kind: 'url-credentials' })
      return `${prefix}:${REDACTED}@`
    })
    out = out.replace(LITERAL_ASSIGNMENT, (m, name: string, sep: string, q: string, value) => {
      if (String(value).startsWith(REDACTED)) return m
      redactions.push({ line: lineNo, kind: 'secret-assignment' })
      return `${name}${sep}${q}${REDACTED}${q}`
    })
    if (isConfig) {
      const m = out.match(CONFIG_LINE)
      if (m) {
        const replaced = redactConfigValue(m[4]!)
        if (replaced !== null) {
          redactions.push({ line: lineNo, kind: 'secret-config-value' })
          out = `${m[1]}${m[2]}${m[3]}${replaced}`
        }
      }
    }
    return out
  })
  return { text: lines.join('\n'), redactions }
}
