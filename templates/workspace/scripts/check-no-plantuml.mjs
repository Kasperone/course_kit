#!/usr/bin/env node
// Guard: Slidev renders ```plantuml blocks as <img> requests to `plantUmlServer`, which defaults to
// https://www.plantuml.com and would send the diagram source off-machine. This workspace uses
// Mermaid only; fail dev/build/export if any Markdown file contains a PlantUML block.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
const SKIP = new Set(['node_modules', 'dist', '.git', 'target-repo', 'audio'])
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*plantuml\b/im

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const abs = path.join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) yield* markdownFiles(abs)
    else if (entry.endsWith('.md')) yield abs
  }
}

const offenders = []
for (const file of markdownFiles(root)) {
  if (FENCE.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file))
}

if (offenders.length > 0) {
  console.error(
    'PlantUML blocks are not allowed (diagram source would be sent to a PlantUML server).',
  )
  console.error('Use Mermaid instead. Offending files:')
  for (const f of offenders) console.error(`  - ${f}`)
  process.exit(1)
}
