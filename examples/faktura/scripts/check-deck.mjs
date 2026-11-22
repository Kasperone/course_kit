#!/usr/bin/env node
// Guard for `npm run dev` / `npm run build` (the root slides.md). `course build` / `course dev`
// run the same checks for lesson decks. Decks must stay offline and export-free:
// - no PlantUML: Slidev renders ```plantuml blocks and <PlantUml> as <img> requests to
//   `plantUmlServer` (default https://www.plantuml.com), sending the diagram source off-machine;
// - no web fonts from a CDN (Google Fonts, coollabs): decks use system fonts;
// - no external URLs in deck code (Vue/TS/JS: components, setup files, addons such as the
//   narration player); only localhost is allowed;
// - no remote images, embeds, scripts or styles (Markdown images, src/href on loading tags, CSS
//   url()/@import, <Tweet>/<Youtube>, image:/background:/url: frontmatter, reference-style link
//   definitions, Mermaid `img:` nodes); inline plain links are fine;
// - slide imports (`src:` and `<<<` code snippets) and every local file Slidev turns into an asset
//   import (Markdown images, src/srcset/poster attributes, CSS url(), image:/background:
//   frontmatter, Vue imports) stay inside the scanned files (no absolute paths, paths outside the
//   workspace, symlinks, skipped directories, context packs or secret-looking files such as
//   `.env*` and keys) and are no PlantUML snippets;
// - the root deck's headmatter pins plantUmlServer and favicon (default: cdn.jsdelivr.net) to data:
//   URLs, fonts.provider to "none", browserExporter and mcp to false (no /export page, no
//   deck-editing /__mcp endpoint) and never enables `download`.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
// Skipped at any depth: installed dependencies and git internals. Skipped only at the workspace top
// level: build output, the vendored target, local audio (and `scripts/` for code): Slidev loads
// components/** at any depth, so a nested components/audio/ or components/scripts/ is deck code.
const SKIP_ANYWHERE = new Set(['node_modules', '.git'])
const SKIP_TOP_LEVEL = new Set(['dist', 'target-repo', 'audio'])
// [ \t]*, not \s*: a plain fence whose first line starts with "plantuml" is ordinary code.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*plantuml\b/im
// The name must end at whitespace, `/` or `>`: a quoted `<plantuml.version>` is not the component.
const COMPONENT = /<\s*plant-?uml(?=[\s/>])/i
const WEB_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.coollabs\.io/i
const REMOTE_URL = String.raw`(?:https?:)?//(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/"'\s)>]|$))[\w[]`
const REMOTE_ASSET = new RegExp(
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

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// `src:` values in slide frontmatter, outside fenced code blocks.
function slideImports(text) {
  const out = []
  let fence = null
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (f) {
      if (fence === null) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    const m = fence === null ? line.match(/^src:\s*(.+?)\s*$/) : null
    if (m) out.push(m[1].replace(/^(["'])(.*)\1$/, '$2').replace(/#.*$/, ''))
  }
  return out
}

// Slidev's own pattern for `<<< path#region lang {meta}` code-snippet imports.
const SNIPPET_IMPORT = /^<<<[ \t]*(\S.*?)(#[\w-]+)?[ \t]*(?:[ \t](\S+?))?[ \t]*(\{.*)?$/

// Code-snippet imports of a Markdown file. Every line is scanned, fences included: Slidev resolves
// them inside ```md magic-move blocks, block quotes and lists too.
function snippetImports(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const bare = line.replace(/^(?:[ \t>]|(?:[-*+]|\d+[.)])[ \t])*/, '')
    const m = bare.startsWith('<<<') ? bare.match(SNIPPET_IMPORT) : null
    if (m)
      out.push({ path: m[1], lang: (m[3]?.trim() || path.extname(m[1]).slice(1)).toLowerCase() })
  }
  return out
}

// Files that must never be rendered or shown as code: the shapes of course_kit's context-pack
// denylist (src/lib/context-pack/sensitive.ts; a test keeps the two in step) plus the workspace's
// own course.local.json.
const SECRET_FILE = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.(?!(?:example|sample|template|dist)$)[^/]*$/i,
  /\.env$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|ppk|p8|p12|pfx|jks|keystore|truststore|gpg|pgp|kdbx|ovpn)$/i,
  /(^|\/)(?:\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.htpasswd|\.pgpass|\.dockercfg)$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)(?:\.kube\/config|kubeconfig|[^/]*\.kubeconfig)$/i,
  /(^|\/)(?:credentials|credentials\.[^/]*|[^/]*credentials[^/]*\.json|[^/]*-credentials\.[^/]*)$/i,
  /(^|\/)(?:secret|secrets)\.[^/]*$/i,
  /(^|\/)(?:secret|secrets)\//i,
  /\.(?:tfstate|tfvars)$/i,
  /\.tfstate\.[^/]*$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)application-(?:prod|production|secret|secrets|local)[^/]*\.(?:properties|ya?ml)$/i,
  /(^|\/)course\.local\.json$/i,
]

// True if Slidev must not read `target` (absolute) for an import of `ref`.
function importLeavesTree(target, ref) {
  const rel = path.relative(root, target)
  if (path.isAbsolute(ref)) return true
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return true
  }
  const segments = rel.split(path.sep)
  if (segments.some((s) => SKIP_ANYWHERE.has(s)) || SKIP_TOP_LEVEL.has(segments[0])) return true
  let current = root
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment)
    if (isSymlink(current)) return true
  }
  // A context pack is data quoted from the target repository and is never scanned.
  if (path.basename(rel) === 'context-pack.md') return true
  return SECRET_FILE.some((re) => re.test(rel.split(path.sep).join('/')))
}

// A reference that is not a local file: a URL scheme (but `file:` is local), `//host`, `#id`.
const NON_LOCAL_REF = /^(?:(?!file:)[a-z][a-z0-9+.-]+:|\/\/|#)/i

// Quoted string literals inside a Vue bound attribute value (`:src="'../a.png'"`).
const stringLiterals = (expr) => [...expr.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])

// Local file references that Slidev (Vite) turns into asset imports at build time, whatever their
// extension: Markdown images and reference definitions, src/srcset/poster/... attributes (also Vue
// :src string literals), CSS url() and @import, image:/background: frontmatter and
// import/import()/new URL() specifiers in Vue code. Every line is scanned, fences included.
function localAssetRefs(text) {
  const refs = []
  const add = (ref, code = false) => {
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
    add(m[1].replace(/^(["'])(.*)\1$/, '$2').replace(/[ \t]+#.*$/, ''))
  }
  for (const m of text.matchAll(/\b(?:from|import)\s*(?:\(\s*)?(["'`])([^"'`]+)\1/g)) {
    add(m[2], true)
  }
  for (const m of text.matchAll(/\bnew\s+URL\s*\(\s*(["'`])([^"'`]+)\1/g)) add(m[2], true)

  const tag = /<\s*([A-Za-z][\w:.-]*)((?:[^>"'`]|"[^"]*"|'[^']*'|`[^`]*`)*)>/g
  const attr = /([\w:.@#-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g
  for (const t of text.matchAll(tag)) {
    const name = t[1].toLowerCase()
    for (const a of t[2].matchAll(attr)) {
      const bound = /^(?::|v-bind:)/i.test(a[1])
      const key = a[1].replace(/^(?::|v-bind:)/i, '').toLowerCase()
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

// Absolute paths a local reference can resolve to. Relative references start at the file's own
// directory (`@/` is the deck's directory). A leading `/` is Vite's: the public/ directory or the
// root, an existing filesystem path, or `/@fs/<path>`. Query and fragment are dropped; the raw,
// percent-decoded and backslash-normalised spellings are all tried.
function assetTargets(file, ref) {
  if (NON_LOCAL_REF.test(ref)) return []
  const base = ref.replace(/^file:\/\//i, '').replace(/[?#].*$/s, '')
  if (base === '') return []
  const spellings = new Set([base, base.replace(/\\/g, '/')])
  try {
    spellings.add(decodeURIComponent(base).replace(/\\/g, '/'))
  } catch {
    // not percent-encoded: the raw spelling is all there is
  }
  const targets = []
  for (const v of spellings) {
    if (v.startsWith('/@fs/')) targets.push(v.slice(4))
    else if (v.startsWith('/')) {
      targets.push(path.join(root, 'public', v), path.join(root, v))
      if (existsSync(v)) targets.push(v)
    } else if (v.startsWith('@/')) targets.push(path.resolve(path.dirname(file), v.slice(2)))
    else targets.push(path.resolve(path.dirname(file), v))
  }
  return targets
}

function mentionsRemoteAsset(file) {
  try {
    return lstatSync(file).isFile() && REMOTE_ASSET.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

const EXTERNAL_URL =
  /\b(?:https?|wss?):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/'"`\s]|$))[^\s'"`)]+|["'`(]\s*\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/'"`\s]|$))[a-z0-9-]+\.[a-z0-9.-]+/i

function* files(dir, skipTop = SKIP_TOP_LEVEL, ext = /\.(md|vue|css|html)$/i, atRoot = true) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_ANYWHERE.has(entry.name) || (atRoot && skipTop.has(entry.name))) continue
    const abs = path.join(dir, entry.name)
    // Symlinks are not followed.
    if (entry.isDirectory()) yield* files(abs, skipTop, ext, false)
    else if (entry.isFile() && ext.test(entry.name)) yield abs
  }
}

// File names and import paths can hold control characters: print them escaped, one line each.
const printable = (text) =>
  text.replace(
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    /[\x00-\x1f\x7f-\x9f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  )

const plantUml = []
const webFonts = []
const remote = []
const imports = []
for (const file of files(root)) {
  // Context packs quote the target repository as data; they are not slides (and no deck may import one).
  if (path.basename(file) === 'context-pack.md') continue
  const text = readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  if (/\.(md|vue)$/i.test(file) && (FENCE.test(text) || COMPONENT.test(text))) plantUml.push(rel)
  if (WEB_FONTS.test(text)) webFonts.push(rel)
  if (REMOTE_ASSET.test(text)) remote.push(rel)
  for (const ref of localAssetRefs(text)) {
    if (assetTargets(file, ref).some((t) => importLeavesTree(t, ''))) {
      imports.push(`${rel.split(path.sep).join('/')} -> asset ${ref}`)
    }
  }
  if (/\.md$/i.test(file)) {
    for (const src of slideImports(text)) {
      if (importLeavesTree(path.resolve(path.dirname(file), src), src)) {
        imports.push(`${rel} -> ${src}`)
      }
    }
    for (const snippet of snippetImports(text)) {
      // `@/` is Slidev's root, which is the deck's own directory (checked against Slidev 52.20.1).
      const ref = snippet.path.startsWith('@/') ? snippet.path.slice(2) : snippet.path
      const target = path.resolve(path.dirname(file), ref)
      const bad =
        importLeavesTree(target, snippet.path) ||
        ['plantuml', 'puml'].includes(snippet.lang) ||
        (snippet.lang === 'mermaid' && mentionsRemoteAsset(target))
      if (bad) imports.push(`${rel} -> <<< ${snippet.path}`)
    }
  }
}

// This script and other top-level helpers are not deck code (their comments may cite URLs).
const external = []
for (const file of files(root, new Set([...SKIP_TOP_LEVEL, 'scripts']), /\.(vue|[cm]?[jt]sx?)$/i)) {
  if (EXTERNAL_URL.test(readFileSync(file, 'utf8'))) external.push(path.relative(root, file))
}

function headmatterProblems(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return ['no headmatter']
  const lines = m[1].split(/\r?\n/)
  const key = (k) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}:`))
    if (i < 0) return null
    const children = []
    for (const l of lines.slice(i + 1)) {
      if (l.trim() !== '' && !/^[ \t]/.test(l)) break
      children.push(l)
    }
    return { inline: lines[i].slice(k.length + 1), children }
  }
  const problems = []
  if (!/^\s*["']?data:/.test(key('plantUmlServer')?.inline ?? '')) {
    problems.push('plantUmlServer must be a data: URL')
  }
  const fonts = key('fonts')
  const none = /^\s*["']?none["']?\s*(?:#.*)?$/
  const flow = fonts?.inline.match(/\{([^}]*)\}/)
  const provider = flow
    ? flow[1]
        .split(',')
        .map((p) => p.split(':'))
        .find(([k]) => k.trim() === 'provider')?.[1]
    : fonts?.children.map((l) => l.match(/^\s+provider:(.*)$/)?.[1]).find((v) => v !== undefined)
  if (provider === undefined || !none.test(provider)) problems.push('fonts.provider must be "none"')
  if (!/^\s*["']?data:/.test(key('favicon')?.inline ?? '')) {
    problems.push('favicon must be a data: URL')
  }
  if (!/^\s*false\s*(?:#.*)?$/.test(key('browserExporter')?.inline ?? '')) {
    problems.push('browserExporter must be false')
  }
  if (!/^\s*false\s*(?:#.*)?$/.test(key('mcp')?.inline ?? '')) problems.push('mcp must be false')
  if (/^\s*["']?(?:true|auto)["']?\s*(?:#.*)?$/i.test(key('download')?.inline ?? '')) {
    problems.push('download must not be enabled')
  }
  return problems
}

const deck = headmatterProblems(readFileSync(path.join(root, 'slides.md'), 'utf8'))
let failed = false
if (plantUml.length > 0) {
  failed = true
  console.error(
    'PlantUML blocks are not allowed (diagram source would be sent to a PlantUML server).',
  )
  console.error('Use Mermaid instead. Offending files:')
  for (const f of plantUml) console.error(`  - ${printable(f)}`)
}
if (webFonts.length > 0) {
  failed = true
  console.error('Web fonts from a CDN are not allowed (decks use system fonts). Offending files:')
  for (const f of webFonts) console.error(`  - ${printable(f)}`)
}
if (external.length > 0) {
  failed = true
  console.error('Deck code must not reference external URLs (only localhost). Offending files:')
  for (const f of external) console.error(`  - ${f}`)
}
if (remote.length > 0) {
  failed = true
  console.error(
    'Remote images, embeds, scripts and styles are not allowed (plain links are fine). Offending files:',
  )
  for (const f of remote) console.error(`  - ${printable(f)}`)
}
if (imports.length > 0) {
  failed = true
  console.error(
    'Slide imports (src: and <<< snippets) and asset paths (images, url(), image:/background:, Vue imports) must stay inside the scanned workspace files (no context packs, secret-looking files or PlantUML snippets):',
  )
  for (const f of imports) console.error(`  - ${printable(f)}`)
}
if (deck.length > 0) {
  failed = true
  console.error(`slides.md headmatter: ${deck.join('; ')}`)
}
if (failed) process.exit(1)
