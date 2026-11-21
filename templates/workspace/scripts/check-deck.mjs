#!/usr/bin/env node
// Guard for `npm run dev` / `npm run build` (the root slides.md). `course build` / `course dev`
// run the same checks for lesson decks. Decks must stay offline and export-free:
// - no PlantUML: Slidev renders ```plantuml blocks and <PlantUml> as <img> requests to
//   `plantUmlServer` (default https://www.plantuml.com), sending the diagram source off-machine;
// - no web fonts from a CDN (Google Fonts, coollabs): decks use system fonts;
// - no remote images, embeds, scripts or styles (Markdown images, src/href on loading tags, CSS
//   url()/@import, <Tweet>/<Youtube>, image:/background: frontmatter); plain links are fine;
// - slide imports (`src:`) stay inside the scanned files (no absolute paths, symlinks or skipped
//   directories);
// - the root deck's headmatter pins plantUmlServer and favicon (default: cdn.jsdelivr.net) to data:
//   URLs, fonts.provider to "none", browserExporter and mcp to false (no /export page, no
//   deck-editing /__mcp endpoint) and never enables `download`.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const SKIP = new Set(['node_modules', 'dist', '.git', 'target-repo', 'audio'])
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*plantuml\b/im
const COMPONENT = /<\s*plant-?uml\b/i
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
    String.raw`^\s*(?:background|image)\s*:\s*["']?\s*` + REMOTE_URL,
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

function importLeavesTree(file, src) {
  if (path.isAbsolute(src)) return true
  const rel = path.relative(root, path.resolve(path.dirname(file), src))
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return true
  }
  if (SKIP.has(rel.split(path.sep)[0])) return true
  let current = root
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment)
    if (isSymlink(current)) return true
  }
  return false
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    // Symlinks are not followed.
    if (entry.isDirectory()) yield* files(abs)
    else if (entry.isFile() && /\.(md|vue|css|html)$/i.test(entry.name)) yield abs
  }
}

const plantUml = []
const webFonts = []
const remote = []
const imports = []
for (const file of files(root)) {
  const text = readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  if (/\.(md|vue)$/i.test(file) && (FENCE.test(text) || COMPONENT.test(text))) plantUml.push(rel)
  if (WEB_FONTS.test(text)) webFonts.push(rel)
  // Context packs quote the target repository as data; they are not slides.
  if (path.basename(file) === 'context-pack.md') continue
  if (REMOTE_ASSET.test(text)) remote.push(rel)
  if (/\.md$/i.test(file)) {
    for (const src of slideImports(text)) {
      if (importLeavesTree(file, src)) imports.push(`${rel} -> ${src}`)
    }
  }
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
  for (const f of plantUml) console.error(`  - ${f}`)
}
if (webFonts.length > 0) {
  failed = true
  console.error('Web fonts from a CDN are not allowed (decks use system fonts). Offending files:')
  for (const f of webFonts) console.error(`  - ${f}`)
}
if (remote.length > 0) {
  failed = true
  console.error(
    'Remote images, embeds, scripts and styles are not allowed (plain links are fine). Offending files:',
  )
  for (const f of remote) console.error(`  - ${f}`)
}
if (imports.length > 0) {
  failed = true
  console.error('Slide imports (src:) must stay inside the scanned workspace files:')
  for (const f of imports) console.error(`  - ${f}`)
}
if (deck.length > 0) {
  failed = true
  console.error(`slides.md headmatter: ${deck.join('; ')}`)
}
if (failed) process.exit(1)
