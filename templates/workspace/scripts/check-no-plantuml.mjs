#!/usr/bin/env node
// Guard: Slidev renders ```plantuml blocks as <img> requests to `plantUmlServer`, which defaults to
// https://www.plantuml.com and would send the diagram source off-machine. This workspace uses
// Mermaid only; fail dev/build/export if any Markdown file contains a PlantUML block or Slidev's
// <PlantUml> component (it renders `server`/`code` props as given, bypassing `plantUmlServer`).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const SKIP = new Set(['node_modules', 'dist', '.git', 'target-repo', 'audio'])
const PACK = /^context-pack\.md$/
// [ \t]*, not \s*: a plain fence whose first line starts with "plantuml" is not a PlantUML block.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*plantuml\b/im
const COMPONENT = /<\s*plant-?uml\b/i

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    // Symlinks are never followed: a loop would never end, and a link can point outside the deck.
    if (entry.isDirectory()) yield* markdownFiles(abs)
    // Generated context packs quote the target repo and are never rendered as slides.
    else if (entry.isFile() && entry.name.endsWith('.md') && !PACK.test(entry.name)) yield abs
  }
}

const offenders = []
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, 'utf8')
  if (FENCE.test(text) || COMPONENT.test(text)) offenders.push(path.relative(root, file))
}

if (offenders.length > 0) {
  console.error(
    'PlantUML blocks and <PlantUml> components are not allowed (diagram source would be sent to a PlantUML server).',
  )
  console.error('Use Mermaid instead. Offending files:')
  for (const f of offenders) console.error(`  - ${f}`)
  process.exit(1)
}
