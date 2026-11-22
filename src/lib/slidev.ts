import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { sensitiveReason } from './context-pack/sensitive.js'

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

/**
 * A fenced PlantUML block (``` or ~~~, up to 3 spaces of indent). `[ \t]*`, not `\s*`: a plain
 * fence whose first line starts with "plantuml" is ordinary code, not an info string.
 */
export const PLANTUML_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*plantuml\b/im
/**
 * Slidev's built-in component used directly: `<PlantUml …>`, `<plant-uml …>` or a self-closing one.
 * The name must end at whitespace, `/` or `>`: a quoted `<plantuml.version>` (pom.xml) is not it.
 */
export const PLANTUML_COMPONENT_RE = /<\s*plant-?uml(?=[\s/>])/i
/** Web-font CDNs Slidev can load from (Google Fonts, coollabs). */
export const WEB_FONT_HOST_RE = /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.coollabs\.io/i

/** An absolute (http/https) or protocol-relative URL to a host other than loopback. */
const REMOTE_URL = String.raw`(?:https?:)?//(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/"'\s)>]|$))[\w[]`

/**
 * Markup that makes the browser fetch a remote resource while a slide renders: Markdown images,
 * `src`/`href`/`poster`/... on loading tags (also Vue `:src`), CSS `url()` and `@import`, Slidev's
 * `<Tweet>`/`<Youtube>`, slide `image:`/`background:`/`url:` frontmatter (`url:` feeds the iframe
 * layouts), reference-style link definitions (`[label]: https://…`, which also flags reference-style
 * plain links) and Mermaid image nodes (`A@{ img: "https://…" }`). Inline plain links are fine.
 */
export const REMOTE_ASSET_RE = new RegExp(
  [
    String.raw`!\[[^\]]*\]\(\s*<?` + REMOTE_URL,
    String.raw`<\s*(?:img|iframe|frame|script|link|video|audio|source|track|embed|object|image|use)\b[^>]*?\s(?::|v-bind:)?(?:src|srcset|href|xlink:href|poster|data)\s*=\s*["'\x60\s]*` +
      REMOTE_URL,
    String.raw`url\(\s*["']?\s*` + REMOTE_URL,
    String.raw`@import\s+["']\s*` + REMOTE_URL,
    String.raw`<\s*(?:tweet|youtube)\b`,
    String.raw`^\s*(?:background|image|url)\s*:\s*["']?\s*` + REMOTE_URL,
    String.raw`^ {0,3}\[[^\]]+\]:\s*<?` + REMOTE_URL,
    String.raw`\bimg\s*:\s*["']\s*` + REMOTE_URL,
  ].join('|'),
  'im',
)

/**
 * Directories a scan skips. `anywhere`: installed dependencies and git internals, at any depth.
 * `topLevel`: workspace-level directories only (build output, the vendored target, local audio, and
 * for code scans the helper `scripts/`): Slidev loads `components/**` at any depth, so a nested
 * `components/audio/` or `components/scripts/` is deck code and must be scanned.
 */
export type WalkSkip = { anywhere: Set<string>; topLevel: Set<string> }

const GUARD_SKIP: WalkSkip = {
  anywhere: new Set(['node_modules', '.git']),
  topLevel: new Set(['dist', 'target-repo', 'audio']),
}
const NO_SKIP: WalkSkip = { anywhere: new Set(), topLevel: new Set() }

function* walkFiles(dir: string, skip: WalkSkip, atRoot = true): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.anywhere.has(entry.name) || (atRoot && skip.topLevel.has(entry.name))) continue
    const abs = path.join(dir, entry.name)
    // Symlinks are never followed: a link could point anywhere on the machine.
    if (entry.isDirectory()) yield* walkFiles(abs, skip, false)
    else if (entry.isFile()) yield abs
  }
}

/** True if a workspace-relative path lies in a directory the scans skip. */
function isSkippedPath(rel: string): boolean {
  const segments = rel.split(path.sep)
  return segments.some((s) => GUARD_SKIP.anywhere.has(s)) || GUARD_SKIP.topLevel.has(segments[0]!)
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

/** Generated context packs quote the target repository as data; they are never rendered. */
const isNotContextPack = (file: string) => path.basename(file) !== 'context-pack.md'

/**
 * Workspace Markdown/Vue files that contain a PlantUML block or component (relative paths).
 * Context packs are skipped (see `findOutsideImports`: a deck cannot import one).
 */
export function findPlantUmlFiles(courseDir: string): string[] {
  return scanWorkspace(
    courseDir,
    /\.(md|vue)$/i,
    (t) => PLANTUML_FENCE_RE.test(t) || PLANTUML_COMPONENT_RE.test(t),
    isNotContextPack,
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
    isNotContextPack,
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

/** Slidev's own pattern for `<<< path#region lang {meta}` (node/syntax/snippet in @slidev/cli). */
const SNIPPET_IMPORT_RE = /^<<<[ \t]*(\S.*?)(#[\w-]+)?[ \t]*(?:[ \t](\S+?))?[ \t]*(\{.*)?$/

export type SnippetImport = { path: string; lang: string }

/**
 * Code-snippet imports (`<<< ../file.ts ts`) of a Markdown file. Slidev reads these at build time
 * and inlines the file as a code block. Every line is scanned, fences included: Slidev resolves
 * them inside ```md magic-move blocks too, and in block quotes and lists, so a conservative scan
 * accepts a false positive (a line of code that starts with `<<<`) over a missed import.
 */
export function snippetImports(text: string): SnippetImport[] {
  const out: SnippetImport[] = []
  for (const line of text.split(/\r?\n/)) {
    const bare = line.replace(/^(?:[ \t>]|(?:[-*+]|\d+[.)])[ \t])*/, '')
    const m = bare.startsWith('<<<') ? bare.match(SNIPPET_IMPORT_RE) : null
    if (!m) continue
    const lang = (m[3]?.trim() || path.extname(m[1]!).slice(1)).toLowerCase()
    out.push({ path: m[1]!, lang })
  }
  return out
}

/** Why Slidev must not read `target` (absolute) for an import of `ref`, or null if it may. */
function importProblem(root: string, target: string, ref: string): string | null {
  const rel = path.relative(root, target)
  if (
    path.isAbsolute(ref) ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith('..' + path.sep) ||
    path.isAbsolute(rel)
  ) {
    return 'outside the workspace'
  }
  if (isSkippedPath(rel)) return 'a directory the guard does not scan'
  if (goesThroughSymlink(root, rel)) return 'a symlink'
  // A pack is data quoted from the target repository and is not scanned; secret files must never
  // be rendered or shown as code.
  if (path.basename(rel) === 'context-pack.md') return 'a context pack'
  const posix = rel.split(path.sep).join('/')
  if (sensitiveReason(posix) !== null || path.basename(rel) === 'course.local.json') {
    return 'a secret-looking file'
  }
  return null
}

/**
 * Slide imports that Slidev would render but the checks never saw: `src: ./other.md` and code
 * snippets (`<<< ./code.ts`). Refused: absolute paths, paths outside the workspace, into a
 * directory the guard skips, through a symlink, to a context pack or a secret-looking file
 * (`.env*`, keys: the context-pack denylist), and snippets in a PlantUML language (Slidev renders
 * them as a PlantUML request) or Mermaid snippets that load a remote image. Returns "file -> src"
 * and "file -> <<< path" strings.
 */
export function findOutsideImports(courseDir: string): string[] {
  const root = path.resolve(courseDir)
  const offenders: string[] = []
  for (const file of walkFiles(root, GUARD_SKIP)) {
    if (!/\.md$/i.test(file) || path.basename(file) === 'context-pack.md') continue
    const text = readFileSync(file, 'utf8')
    const from = path.relative(root, file).split(path.sep).join('/')
    for (const src of slideImports(text)) {
      if (importProblem(root, path.resolve(path.dirname(file), src), src)) {
        offenders.push(`${from} -> ${src}`)
      }
    }
    for (const snippet of snippetImports(text)) {
      // `@/` is Slidev's root, which is the deck's own directory (checked against Slidev 52.20.1).
      const ref = snippet.path.startsWith('@/') ? snippet.path.slice(2) : snippet.path
      const target = path.resolve(path.dirname(file), ref)
      const bad =
        importProblem(root, target, snippet.path) !== null ||
        ['plantuml', 'puml'].includes(snippet.lang) ||
        (snippet.lang === 'mermaid' && mentionsRemoteAsset(target))
      if (bad) offenders.push(`${from} -> <<< ${snippet.path}`)
    }
  }
  return offenders.sort()
}

function mentionsRemoteAsset(file: string): boolean {
  try {
    return statSync(file).isFile() && REMOTE_ASSET_RE.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/** Workspace Markdown/Vue/CSS/HTML files that load web fonts from a CDN (relative paths). */
export function findWebFontFiles(courseDir: string): string[] {
  return scanWorkspace(
    courseDir,
    /\.(md|vue|css|html)$/i,
    (t) => WEB_FONT_HOST_RE.test(t),
    isNotContextPack,
  )
}

/**
 * An absolute or protocol-relative URL to another host in deck code: http(s)/ws(s) URLs and
 * `"//host…"` / `url(//host…)`. Loopback hosts (localhost, 127.0.0.1, [::1]) are allowed.
 */
export const EXTERNAL_URL_RE =
  /\b(?:https?|wss?):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/'"`\s]|$))[^\s'"`)]+|["'`(]\s*\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/'"`\s]|$))[a-z0-9-]+\.[a-z0-9.-]+/i

/** The top-level `scripts/` holds workspace helpers, not deck code (their comments may cite URLs). */
const CODE_SKIP: WalkSkip = {
  anywhere: GUARD_SKIP.anywhere,
  topLevel: new Set([...GUARD_SKIP.topLevel, 'scripts']),
}

/** Files Slidev loads as code: Vue components and JS/TS (also JSX/TSX, which it registers too). */
const CODE_FILE_RE = /\.(vue|[cm]?[jt]sx?)$/i

/**
 * Workspace code that a deck can load (Vue/TS/JS: components, layouts, setup files, addons) and
 * that references an external URL (relative paths). Decks stay offline, so such code would make
 * the browser leave the machine.
 */
export function findExternalUrlFiles(courseDir: string): string[] {
  const offenders: string[] = []
  for (const file of walkFiles(courseDir, CODE_SKIP)) {
    if (!CODE_FILE_RE.test(file)) continue
    if (EXTERNAL_URL_RE.test(readFileSync(file, 'utf8'))) {
      offenders.push(path.relative(courseDir, file).split(path.sep).join('/'))
    }
  }
  return offenders.sort()
}

export type BuildRef = {
  file: string
  what: 'PlantUML server' | 'web fonts' | 'CDN favicon' | 'provider API'
}

/** Hosts of the paid APIs: only the local backend may talk to them, never the deck. */
export const PROVIDER_API_HOST_RE = /api\.anthropic\.com|api\.elevenlabs\.io/i

/**
 * Built files (HTML/JS/CSS/JSON/text) that mention a public PlantUML server, a web-font CDN or a
 * provider API host (the deck must only talk to the local backend).
 */
export function findForbiddenBuildRefs(distDir: string): BuildRef[] {
  const hits: BuildRef[] = []
  if (!existsSync(distDir)) return hits
  for (const file of walkFiles(distDir, NO_SKIP)) {
    if (!/\.(html|m?js|css|json|txt|svg|map)$|_redirects$/i.test(file)) continue
    const text = readFileSync(file, 'utf8')
    if (/plantuml\.com/i.test(text)) hits.push({ file, what: 'PlantUML server' })
    if (WEB_FONT_HOST_RE.test(text)) hits.push({ file, what: 'web fonts' })
    if (/\.html$/i.test(file) && /cdn\.jsdelivr\.net/i.test(text)) {
      hits.push({ file, what: 'CDN favicon' })
    }
    if (PROVIDER_API_HOST_RE.test(text)) hits.push({ file, what: 'provider API' })
  }
  return hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
