#!/usr/bin/env node
// Guard: Slidev renders ```plantuml blocks as <img> requests to `plantUmlServer`, which defaults to
// https://www.plantuml.com and would send the diagram source off-machine. This workspace uses
// Mermaid only; fail dev/build if any Markdown or Vue file contains a PlantUML block or uses the
// <PlantUml> component. `course build` / `course dev` run the same check.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const SKIP = new Set(['node_modules', 'dist', '.git', 'target-repo', 'audio'])
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*plantuml\b/im
const COMPONENT = /<\s*plant-?uml\b/i

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    // Symlinks are not followed.
    if (entry.isDirectory()) yield* markdownFiles(abs)
    else if (entry.isFile() && /\.(md|vue)$/i.test(entry.name)) yield abs
  }
}

const offenders = []
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, 'utf8')
  if (FENCE.test(text) || COMPONENT.test(text)) offenders.push(path.relative(root, file))
}

if (offenders.length > 0) {
  console.error(
    'PlantUML blocks are not allowed (diagram source would be sent to a PlantUML server).',
  )
  console.error('Use Mermaid instead. Offending files:')
  for (const f of offenders) console.error(`  - ${f}`)
  process.exit(1)
}
