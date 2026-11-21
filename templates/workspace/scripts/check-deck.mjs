#!/usr/bin/env node
// Guard for `npm run dev` / `npm run build` (the root slides.md). `course build` / `course dev`
// run the same checks for lesson decks. Decks must stay offline and export-free:
// - no PlantUML: Slidev renders ```plantuml blocks and <PlantUml> as <img> requests to
//   `plantUmlServer` (default https://www.plantuml.com), sending the diagram source off-machine;
// - no web fonts from a CDN (Google Fonts, coollabs): decks use system fonts;
// - the root deck's headmatter pins plantUmlServer and favicon (default: cdn.jsdelivr.net) to data:
//   URLs, fonts.provider to "none", browserExporter to false (no /export page) and never enables
//   `download`.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const SKIP = new Set(['node_modules', 'dist', '.git', 'target-repo', 'audio'])
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*plantuml\b/im
const COMPONENT = /<\s*plant-?uml\b/i
const WEB_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.coollabs\.io/i

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
for (const file of files(root)) {
  const text = readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  if (/\.(md|vue)$/i.test(file) && (FENCE.test(text) || COMPONENT.test(text))) plantUml.push(rel)
  if (WEB_FONTS.test(text)) webFonts.push(rel)
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
if (deck.length > 0) {
  failed = true
  console.error(`slides.md headmatter: ${deck.join('; ')}`)
}
if (failed) process.exit(1)
