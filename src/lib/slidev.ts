import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
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
 * Slidev's default favicon is hosted on cdn.jsdelivr.net. An empty data: URL loads nothing; a
 * /favicon.svg path would break under `slidev build --base` and lesson decks have their own root.
 */
export const NO_FAVICON = 'data:,'

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
    `favicon: ${JSON.stringify(NO_FAVICON)}`,
    // No /export page or export button in the dev server, and no PDF download in builds.
    'browserExporter: false',
    'download: false',
    // No MCP server in the dev server: its tools rewrite the deck files on disk, unauthenticated.
    'mcp: false',
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

/** The inline value of a top-level headmatter key (trimmed), or null if the deck has none. */
export function headmatterValue(deckText: string, key: string): string | null {
  const block = headmatterOf(deckText)
  const entry = block === null ? null : topLevelKey(block, key)
  return entry ? entry.inline.trim() : null
}

const NONE_RE = /^\s*["']?none["']?\s*(?:#.*)?$/

/**
 * Why a deck's headmatter is not offline-safe (empty when it is): PlantUML and the favicon must
 * point at data: URLs, fonts must use no web-font provider, and the browser exporter, the MCP
 * server and PDF download must be off.
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

  const favicon = topLevelKey(block, 'favicon')
  if (!favicon || !/^\s*["']?data:/.test(favicon.inline)) {
    problems.push(
      `favicon must be ${JSON.stringify(NO_FAVICON)} (Slidev's default is loaded from cdn.jsdelivr.net)`,
    )
  }

  const exporter = topLevelKey(block, 'browserExporter')
  if (!exporter || !/^\s*false\s*(?:#.*)?$/.test(exporter.inline)) {
    problems.push('browserExporter must be false (no export page in the dev server)')
  }

  const mcp = topLevelKey(block, 'mcp')
  if (!mcp || !/^\s*false\s*(?:#.*)?$/.test(mcp.inline)) {
    problems.push('mcp must be false (no deck-editing MCP server in the dev server)')
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

/** An absolute (http/https) or protocol-relative URL to a host other than loopback. */
const REMOTE_URL = String.raw`(?:https?:)?//(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/"'\s)>]|$))[\w[]`

/**
 * Markup that makes the browser fetch a remote resource while a slide renders: Markdown images,
 * `src`/`href`/`poster`/... on loading tags (also Vue `:src`), CSS `url()` and `@import`, Slidev's
 * `<Tweet>`/`<Youtube>`, and slide `image:`/`background:` frontmatter. Plain links are fine.
 */
export const REMOTE_ASSET_RE = new RegExp(
  [
    String.raw`!\[[^\]]*\]\(\s*<?` + REMOTE_URL,
    String.raw`<\s*(?:img|iframe|frame|script|link|video|audio|source|track|embed|object|image|use)\b[^>]*?\s(?::|v-bind:)?(?:src|srcset|href|xlink:href|poster|data)\s*=\s*["'\x60\s]*` +
      REMOTE_URL,
    String.raw`url\(\s*["']?\s*` + REMOTE_URL,
    String.raw`@import\s+["']\s*` + REMOTE_URL,
    String.raw`<\s*(?:tweet|youtube)\b`,
    String.raw`^\s*(?:background|image)\s*:\s*["']?\s*` + REMOTE_URL,
  ].join('|'),
  'im',
)

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

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** True if any existing component of `rel` below `root` is a symlink. */
function goesThroughSymlink(root: string, rel: string): boolean {
  let current = root
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment)
    if (isSymlink(current)) return true
  }
  return false
}

function scanWorkspace(
  courseDir: string,
  ext: RegExp,
  matches: (text: string) => boolean,
  include: (file: string) => boolean = () => true,
) {
  const offenders: string[] = []
  for (const file of walkFiles(courseDir, GUARD_SKIP)) {
    if (!ext.test(file) || !include(file)) continue
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

/**
 * Workspace Markdown/Vue/CSS/HTML files that load a remote resource when a slide renders (relative
 * paths). Context packs are skipped: they quote the target repository as data and are not slides.
 */
export function findRemoteAssetFiles(courseDir: string): string[] {
  return scanWorkspace(
    courseDir,
    /\.(md|vue|css|html)$/i,
    (t) => REMOTE_ASSET_RE.test(t),
    (file) => path.basename(file) !== 'context-pack.md',
  )
}

/** `src:` values in slide frontmatter of a Markdown file, outside fenced code blocks. */
export function slideImports(text: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      continue
    }
    const m = fence === null ? line.match(/^src:\s*(.+?)\s*$/) : null
    if (m) out.push(m[1]!.replace(/^(["'])(.*)\1$/, '$2').replace(/#.*$/, ''))
  }
  return out
}

/**
 * Slide imports (`src: ./other.md`) that leave the scanned tree: absolute paths, paths outside the
 * workspace, into a directory the guard skips, or through a symlink. Slidev would render them, but
 * the PlantUML, font and remote-asset checks never saw them. Returns "file -> src" strings.
 */
export function findOutsideImports(courseDir: string): string[] {
  const root = path.resolve(courseDir)
  const offenders: string[] = []
  for (const file of walkFiles(root, GUARD_SKIP)) {
    if (!/\.md$/i.test(file) || path.basename(file) === 'context-pack.md') continue
    for (const src of slideImports(readFileSync(file, 'utf8'))) {
      const rel = path.relative(root, path.resolve(path.dirname(file), src))
      const outside =
        path.isAbsolute(src) ||
        rel === '' ||
        rel === '..' ||
        rel.startsWith('..' + path.sep) ||
        path.isAbsolute(rel) ||
        GUARD_SKIP.has(rel.split(path.sep)[0]!) ||
        goesThroughSymlink(root, rel)
      if (outside)
        offenders.push(`${path.relative(root, file).split(path.sep).join('/')} -> ${src}`)
    }
  }
  return offenders.sort()
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

export type BuildRef = { file: string; what: 'PlantUML server' | 'web fonts' | 'CDN favicon' }

/** Built files (HTML/JS/CSS/JSON/text) that mention a public PlantUML server or web-font CDN. */
export function findForbiddenBuildRefs(distDir: string): BuildRef[] {
  const hits: BuildRef[] = []
  if (!existsSync(distDir)) return hits
  for (const file of walkFiles(distDir, new Set())) {
    if (!/\.(html|m?js|css|json|txt|svg|map)$|_redirects$/i.test(file)) continue
    const text = readFileSync(file, 'utf8')
    if (/plantuml\.com/i.test(text)) hits.push({ file, what: 'PlantUML server' })
    if (WEB_FONT_HOST_RE.test(text)) hits.push({ file, what: 'web fonts' })
    if (/\.html$/i.test(file) && /cdn\.jsdelivr\.net/i.test(text)) {
      hits.push({ file, what: 'CDN favicon' })
    }
  }
  return hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
