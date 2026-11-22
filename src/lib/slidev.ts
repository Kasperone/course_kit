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
const REMOTE_URL = String.raw`(?:https?:[\\/]*|[\\/]{2})(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/"'\s)>]|$))[\w[]`

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

/**
 * `src:` values anywhere in a Markdown file. Slidev reads slide frontmatter in more spellings than
 * the canonical `---` block: from a ```yaml code block at the start of a slide, and its YAML parser
 * takes a quoted key (`"src": x`), an indented mapping (`  src: x`), the flow form (`{ src: x }`)
 * and a value on the next line. So every line is scanned, fences included: a false positive (prose
 * that starts a line with `src:`) only matters when the path itself is refused.
 */
export function slideImports(text: string): string[] {
  const out: string[] = []
  const clean = (v: string): string =>
    // A quoted value ends at its closing quote (a trailing comment may follow); `#2-3` is a slide range.
    (/^(["'])(.*?)\1/.exec(v.trim())?.[2] ?? v).replace(/#.*$/, '').trim()
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const block = line.match(/^[ \t]*(?:-[ \t]+)?["']?src["']?[ \t]*:[ \t]*(.*?)[ \t]*$/)
    if (block) {
      let value = block[1]!
      if (value === '' || /^[|>][+-]?\d?$/.test(value)) {
        value = lines.slice(i + 1).find((l) => l.trim() !== '') ?? ''
      }
      if (clean(value) !== '') out.push(clean(value))
    }
    for (const m of line.matchAll(
      /[{,][ \t]*["']?src["']?[ \t]*:[ \t]*("[^"]*"|'[^']*'|[^,}]*)/g,
    )) {
      if (clean(m[1]!) !== '') out.push(clean(m[1]!))
    }
  })
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

/** A reference that is not a local file: a URL scheme (but `file:` is local), `//host`, `#id`. */
const NON_LOCAL_REF = /^(?:(?!file:)[a-z][a-z0-9+.-]+:|\/\/|#)/i

/** Quoted string literals inside a Vue bound attribute value (`:src="'../a.png'"`). */
function stringLiterals(expr: string): string[] {
  return [...expr.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!)
}

/**
 * Local file references that Slidev (Vite) turns into asset imports at build time, whatever their
 * extension: Markdown images and reference definitions, `src`/`srcset`/`poster`/... attributes
 * (also Vue `:src` string literals), CSS `url()` and `@import`, slide `image:`/`background:`
 * frontmatter and `import`/`import()`/`new URL()` specifiers in Vue code. Remote URLs, `data:` URLs
 * and `#fragments` are not local and are left out. Every line is scanned, fences included
 * (Slidev resolves images inside ```md magic-move blocks); a false positive only matters when the
 * path itself is refused.
 */
export function localAssetRefs(text: string): string[] {
  const refs: string[] = []
  const add = (ref: string | undefined, code = false) => {
    if (ref === undefined) return
    const r = ref.trim()
    if (r === '' || (code && !/^(?:\.|\/|@\/)/.test(r))) return
    refs.push(r)
  }

  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))/g)) add(m[1] ?? m[2])
  for (const m of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/gm)) add(m[1] ?? m[2])
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi)) {
    add(m[1] ?? m[2] ?? m[3])
  }
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi)) {
    add(m[1] ?? m[2])
  }
  for (const m of text.matchAll(/^[ \t]*(?:image|background)[ \t]*:[ \t]*(.+?)[ \t]*$/gim)) {
    add(m[1]!.replace(/^(["'])(.*)\1$/, '$2').replace(/[ \t]+#.*$/, ''))
  }
  for (const m of text.matchAll(/\b(?:from|import)\s*(?:\(\s*)?(["'`])([^"'`]+)\1/g)) {
    add(m[2], true)
  }
  for (const m of text.matchAll(/\bnew\s+URL\s*\(\s*(["'`])([^"'`]+)\1/g)) add(m[2], true)

  const tag = /<\s*([A-Za-z][\w:.-]*)((?:[^>"'`]|"[^"]*"|'[^']*'|`[^`]*`)*)>/g
  const attr = /([\w:.@#-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g
  for (const t of text.matchAll(tag)) {
    const name = t[1]!.toLowerCase()
    for (const a of t[2]!.matchAll(attr)) {
      const bound = /^(?::|v-bind:)/i.test(a[1]!)
      const key = a[1]!.replace(/^(?::|v-bind:)/i, '').toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      const wanted =
        ['src', 'srcset', 'poster', 'xlink:href', 'background'].includes(key) ||
        (key === 'href' && name !== 'a') ||
        (key === 'data' && name === 'object')
      if (!wanted) continue
      for (const v of bound ? stringLiterals(value) : [value]) {
        if (key === 'srcset') for (const c of v.split(',')) add(c.trim().split(/\s+/)[0])
        else add(v)
      }
    }
  }
  return [...new Set(refs)]
}

/**
 * `@/` is Slidev's `userRoot`: the directory of the entry deck, also inside a file pulled in with
 * `src:`. The entry is not known here, so the importing file's directory and every deck directory
 * (a `slides.md`) are all checked.
 */
function atTargets(file: string, rest: string, deckDirs: string[]): string[] {
  return [path.dirname(file), ...deckDirs].map((dir) => path.resolve(dir, rest))
}

/**
 * Absolute paths a local reference can resolve to. Relative references start at the file's own
 * directory (`@/` is the deck's directory, like for snippets). A leading `/` is Vite's: the
 * `public/` directory or the root, an existing filesystem path, or `/@fs/<path>`. Query and
 * fragment are dropped; the raw, percent-decoded and backslash-normalised spellings are all tried.
 */
function assetTargets(root: string, file: string, ref: string, deckDirs: string[]): string[] {
  if (NON_LOCAL_REF.test(ref)) return []
  const base = ref.replace(/^file:\/\//i, '').replace(/[?#].*$/s, '')
  if (base === '') return []
  const spellings = new Set([base, base.replace(/\\/g, '/')])
  try {
    spellings.add(decodeURIComponent(base).replace(/\\/g, '/'))
  } catch {
    // not percent-encoded: the raw spelling is all there is
  }
  const targets: string[] = []
  for (const v of spellings) {
    if (v.startsWith('/@fs/')) targets.push(v.slice(4))
    else if (v.startsWith('/')) {
      targets.push(path.join(root, 'public', v), path.join(root, v))
      if (existsSync(v)) targets.push(v)
    } else if (v.startsWith('@/')) targets.push(...atTargets(file, v.slice(2), deckDirs))
    else targets.push(path.resolve(path.dirname(file), v))
  }
  return targets
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
  if (GUARD_SKIP.has(rel.split(path.sep)[0]!)) return 'a directory the guard does not scan'
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
 * Slide imports and asset paths that Slidev would read but the checks never saw: `src: ./other.md`,
 * code snippets (`<<< ./code.ts`) and every local file reference that becomes an asset import
 * (images, `url()`, `image:`/`background:` frontmatter, Vue imports; see `localAssetRefs`; Slidev
 * itself refuses only paths outside its Vite root, and then only for some of those forms). Refused:
 * absolute paths, paths outside the workspace, into a directory the guard skips, through a symlink,
 * to a context pack or a secret-looking file (`.env*`, keys: the context-pack denylist), and
 * snippets in a PlantUML language (Slidev renders them as a PlantUML request) or Mermaid snippets
 * that load a remote image. Returns "file -> src", "file -> <<< path" and "file -> asset path"
 * strings.
 */
export function findOutsideImports(courseDir: string): string[] {
  const root = path.resolve(courseDir)
  const offenders: string[] = []
  const all = [...walkFiles(root, GUARD_SKIP)]
  const deckDirs = all.filter((f) => path.basename(f) === 'slides.md').map((f) => path.dirname(f))
  for (const file of all) {
    if (!/\.(md|vue|css|html)$/i.test(file) || path.basename(file) === 'context-pack.md') continue
    const text = readFileSync(file, 'utf8')
    const from = path.relative(root, file).split(path.sep).join('/')
    for (const ref of localAssetRefs(text)) {
      const bad = assetTargets(root, file, ref, deckDirs).some(
        (t) => importProblem(root, t, '') !== null,
      )
      if (bad) offenders.push(`${from} -> asset ${ref}`)
    }
    if (!/\.md$/i.test(file)) continue
    for (const src of slideImports(text)) {
      if (importProblem(root, path.resolve(path.dirname(file), src), src)) {
        offenders.push(`${from} -> ${src}`)
      }
    }
    for (const snippet of snippetImports(text)) {
      const targets = snippet.path.startsWith('@/')
        ? atTargets(file, snippet.path.slice(2), deckDirs)
        : [path.resolve(path.dirname(file), snippet.path)]
      const bad =
        targets.some(
          (target) =>
            importProblem(root, target, snippet.path) !== null ||
            (snippet.lang === 'mermaid' && mentionsRemoteAsset(target)),
        ) || ['plantuml', 'puml'].includes(snippet.lang)
      if (bad) offenders.push(`${from} -> <<< ${snippet.path}`)
    }
  }
  return [...new Set(offenders)].sort()
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
