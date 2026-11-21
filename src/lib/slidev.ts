import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Slidev renders ```plantuml blocks as `<img src="${plantUmlServer}/svg/...">` (default server:
 * plantuml.com). A data: URL turns that into a local no-op, so diagram source never leaves the
 * machine. The workspace also ships scripts/check-deck.mjs, which fails `npm run dev/build`.
 */
export const PLANTUML_DISABLED_SERVER = 'data:text/plain,plantuml-disabled'

/**
 * System font stacks with no web-font provider: Slidev then emits no Google Fonts `<link>`, so a
 * deck makes no font requests (fully offline). Slidev appends its own fallback stacks.
 */
export const SYSTEM_FONTS = {
  sans: 'system-ui',
  serif: 'ui-serif',
  mono: 'ui-monospace',
  provider: 'none',
} as const

/**
 * Headmatter for a generated deck. Values are emitted as JSON strings, which are valid YAML
 * scalars, so titles containing `: `, quotes or `#` cannot break the frontmatter. Besides title
 * and language, it pins the offline policy checked by offlineHeadmatterProblems().
 */
export function deckFrontmatter(fields: { title: string; lang: string }): string {
  return [
    '---',
    'theme: default',
    `title: ${JSON.stringify(fields.title)}`,
    `lang: ${JSON.stringify(fields.lang)}`,
    `plantUmlServer: ${JSON.stringify(PLANTUML_DISABLED_SERVER)}`,
    'fonts:',
    ...Object.entries(SYSTEM_FONTS).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    // No /export page or export button in the dev server, and no PDF download in builds.
    'browserExporter: false',
    'download: false',
    '---',
  ].join('\n')
}

/** The first `---` block of a deck (its headmatter), or null. */
export function headmatterOf(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  return m ? m[1]! : null
}

/** A top-level key of a YAML block: the text after `key:` and the indented lines below it. */
function topLevelKey(block: string, key: string): { inline: string; children: string[] } | null {
  const lines = block.split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (i < 0) return null
  const children: string[] = []
  for (const line of lines.slice(i + 1)) {
    if (line.trim() !== '' && !/^[ \t]/.test(line)) break
    children.push(line)
  }
  return { inline: lines[i]!.slice(key.length + 1), children }
}

const NONE_RE = /^\s*["']?none["']?\s*(?:#.*)?$/

/**
 * Why a deck's headmatter is not offline-safe (empty when it is): PlantUML must point at a data:
 * URL, fonts must use no web-font provider, and the browser exporter and PDF download must be off.
 * Accepts the block (`fonts:` + indented `provider: none`) and flow (`fonts: { provider: none }`)
 * forms.
 */
export function offlineHeadmatterProblems(deckText: string): string[] {
  const block = headmatterOf(deckText)
  if (block === null) return ['no headmatter (--- block at the top of the deck)']
  const problems: string[] = []

  const plantUml = topLevelKey(block, 'plantUmlServer')
  if (!plantUml || !/^\s*["']?data:/.test(plantUml.inline)) {
    problems.push(`plantUmlServer must be ${JSON.stringify(PLANTUML_DISABLED_SERVER)}`)
  }

  const fonts = topLevelKey(block, 'fonts')
  const flow = fonts?.inline.match(/\{([^}]*)\}/)
  const provider = flow
    ? flow[1]!
        .split(',')
        .map((p) => p.split(':'))
        .find(([k]) => k!.trim() === 'provider')?.[1]
    : fonts?.children.map((l) => l.match(/^\s+provider:(.*)$/)?.[1]).find((v) => v !== undefined)
  if (provider === undefined || !NONE_RE.test(provider)) {
    problems.push('fonts.provider must be "none" (system fonts, no Google Fonts requests)')
  }

  const exporter = topLevelKey(block, 'browserExporter')
  if (!exporter || !/^\s*false\s*(?:#.*)?$/.test(exporter.inline)) {
    problems.push('browserExporter must be false (no export page in the dev server)')
  }

  const download = topLevelKey(block, 'download')
  if (download && /^\s*["']?(?:true|auto)["']?\s*(?:#.*)?$/i.test(download.inline)) {
    problems.push('download must not be enabled (no PDF export)')
  }
  return problems
}

/** A fenced PlantUML block (``` or ~~~, up to 3 spaces of indent). */
export const PLANTUML_FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*plantuml\b/im
/** Slidev's built-in component used directly: `<PlantUml …>` or `<plant-uml …>`. */
export const PLANTUML_COMPONENT_RE = /<\s*plant-?uml\b/i
/** Web-font CDNs Slidev can load from (Google Fonts, coollabs). */
export const WEB_FONT_HOST_RE = /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.coollabs\.io/i

/** Workspace directories the guard never scans (dependencies, output, vendored target). */
const GUARD_SKIP = new Set(['node_modules', 'dist', '.git', 'target-repo', 'audio'])

function* walkFiles(dir: string, skip: Set<string>): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    // Symlinks are never followed: a link could point anywhere on the machine.
    if (entry.isDirectory()) yield* walkFiles(abs, skip)
    else if (entry.isFile()) yield abs
  }
}

function scanWorkspace(courseDir: string, ext: RegExp, matches: (text: string) => boolean) {
  const offenders: string[] = []
  for (const file of walkFiles(courseDir, GUARD_SKIP)) {
    if (!ext.test(file)) continue
    if (matches(readFileSync(file, 'utf8'))) {
      offenders.push(path.relative(courseDir, file).split(path.sep).join('/'))
    }
  }
  return offenders.sort()
}

/** Workspace Markdown/Vue files that contain a PlantUML block or component (relative paths). */
export function findPlantUmlFiles(courseDir: string): string[] {
  return scanWorkspace(
    courseDir,
    /\.(md|vue)$/i,
    (t) => PLANTUML_FENCE_RE.test(t) || PLANTUML_COMPONENT_RE.test(t),
  )
}

/** Workspace Markdown/Vue/CSS/HTML files that load web fonts from a CDN (relative paths). */
export function findWebFontFiles(courseDir: string): string[] {
  return scanWorkspace(courseDir, /\.(md|vue|css|html)$/i, (t) => WEB_FONT_HOST_RE.test(t))
}

/**
 * An absolute or protocol-relative URL to another host in deck code: http(s)/ws(s) URLs and
 * `"//host…"` / `url(//host…)`. Loopback hosts (localhost, 127.0.0.1, [::1]) are allowed.
 */
export const EXTERNAL_URL_RE =
  /\b(?:https?|wss?):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/'"`\s]|$))[^\s'"`)]+|["'`(]\s*\/\/(?!(?:localhost|127\.0\.0\.1)\b)[a-z0-9-]+\.[a-z0-9.-]+/i

/** Top-level workspace helpers that are not part of any deck (their comments may cite URLs). */
const CODE_SKIP = new Set([...GUARD_SKIP, 'scripts'])

/**
 * Workspace code that a deck can load (Vue/TS/JS: components, layouts, setup files, addons) and
 * that references an external URL (relative paths). Decks stay offline, so such code would make
 * the browser leave the machine.
 */
export function findExternalUrlFiles(courseDir: string): string[] {
  const offenders: string[] = []
  for (const file of walkFiles(courseDir, CODE_SKIP)) {
    if (!/\.(vue|[cm]?[jt]s)$/i.test(file)) continue
    if (EXTERNAL_URL_RE.test(readFileSync(file, 'utf8'))) {
      offenders.push(path.relative(courseDir, file).split(path.sep).join('/'))
    }
  }
  return offenders.sort()
}

export type BuildRef = { file: string; what: 'PlantUML server' | 'web fonts' }

/** Built files (HTML/JS/CSS/JSON/text) that mention a public PlantUML server or web-font CDN. */
export function findForbiddenBuildRefs(distDir: string): BuildRef[] {
  const hits: BuildRef[] = []
  if (!existsSync(distDir)) return hits
  for (const file of walkFiles(distDir, new Set())) {
    if (!/\.(html|m?js|css|json|txt|svg|map)$|_redirects$/i.test(file)) continue
    const text = readFileSync(file, 'utf8')
    if (/plantuml\.com/i.test(text)) hits.push({ file, what: 'PlantUML server' })
    if (WEB_FONT_HOST_RE.test(text)) hits.push({ file, what: 'web fonts' })
  }
  return hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
