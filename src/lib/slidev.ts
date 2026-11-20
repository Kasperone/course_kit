import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Slidev renders ```plantuml blocks as `<img src="${plantUmlServer}/svg/...">` (default server:
 * plantuml.com). A data: URL turns that into a local no-op, so diagram source never leaves the
 * machine. The workspace also ships scripts/check-no-plantuml.mjs, which fails dev/build/export.
 */
export const PLANTUML_DISABLED_SERVER = 'data:text/plain,plantuml-disabled'

/**
 * Headmatter for a generated deck. Values are emitted as JSON strings, which are valid YAML
 * scalars, so titles containing `: `, quotes or `#` cannot break the frontmatter.
 */
export function deckFrontmatter(fields: { title: string; lang: string }): string {
  return [
    '---',
    'theme: default',
    `title: ${JSON.stringify(fields.title)}`,
    `lang: ${JSON.stringify(fields.lang)}`,
    `plantUmlServer: ${JSON.stringify(PLANTUML_DISABLED_SERVER)}`,
    '---',
  ].join('\n')
}

/** A fenced PlantUML block (``` or ~~~, up to 3 spaces of indent). */
export const PLANTUML_FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*plantuml\b/im
/** Slidev's built-in component used directly: `<PlantUml …>` or `<plant-uml …>`. */
export const PLANTUML_COMPONENT_RE = /<\s*plant-?uml\b/i

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

/** Workspace Markdown/Vue files that contain a PlantUML block or component (relative paths). */
export function findPlantUmlFiles(courseDir: string): string[] {
  const offenders: string[] = []
  for (const file of walkFiles(courseDir, GUARD_SKIP)) {
    if (!/\.(md|vue)$/i.test(file)) continue
    const text = readFileSync(file, 'utf8')
    if (PLANTUML_FENCE_RE.test(text) || PLANTUML_COMPONENT_RE.test(text)) {
      offenders.push(path.relative(courseDir, file).split(path.sep).join('/'))
    }
  }
  return offenders.sort()
}

/** Built files (HTML/JS/CSS/JSON/text) that mention a public PlantUML server. */
export function findPlantUmlServerRefs(distDir: string): string[] {
  const hits: string[] = []
  if (!existsSync(distDir)) return hits
  for (const file of walkFiles(distDir, new Set())) {
    if (!/\.(html|m?js|css|json|txt|svg|map)$|_redirects$/i.test(file)) continue
    if (/plantuml\.com/i.test(readFileSync(file, 'utf8'))) hits.push(file)
  }
  return hits.sort()
}
