import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runBuild, slidevBin } from '../src/commands/slidev.js'
import { findPlantUmlServerRefs, PLANTUML_DISABLED_SERVER } from '../src/lib/slidev.js'

/**
 * Real Slidev builds against the committed example workspace. Runs only when its dependencies are
 * installed (`npm ci --prefix examples/faktura`, done by the CI `deck` job); skipped otherwise.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.join(repoRoot, 'examples', 'faktura')
const installed = existsSync(path.join(workspace, 'node_modules', '@slidev', 'cli', 'package.json'))

const scratch: string[] = []
function cleanup(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
}
afterAll(cleanup)

function allText(dir: string): string {
  let out = ''
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(html|js|css)$/.test(entry.name)) {
      out += readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
    }
  }
  return out
}

/** Build a one-slide deck with a PlantUML block directly with Slidev (bypassing the guard). */
function buildPlantUmlProbe(headmatter: string): string {
  // Inside the workspace so Slidev resolves the theme from its node_modules.
  const dir = mkdtempSync(path.join(workspace, '.e2e-probe-'))
  scratch.push(dir)
  writeFileSync(
    path.join(dir, 'slides.md'),
    `---\ntheme: default\ntitle: "Probe"\n${headmatter}---\n\n# Probe\n\n\`\`\`plantuml\n@startuml\nAlice -> Bob : diagram-source\n@enduml\n\`\`\`\n`,
  )
  const out = path.join(dir, 'out')
  execFileSync(
    process.execPath,
    [slidevBin(workspace), 'build', path.join(dir, 'slides.md'), '--out', out],
    { cwd: workspace, stdio: 'pipe' },
  )
  return out
}

describe.skipIf(!installed)('real Slidev build (examples/faktura)', () => {
  it('headmatter keeps PlantUML off plantuml.com at render time; the scan catches the default', () => {
    try {
      const safe = buildPlantUmlProbe(
        `plantUmlServer: ${JSON.stringify(PLANTUML_DISABLED_SERVER)}\n`,
      )
      expect(findPlantUmlServerRefs(safe)).toEqual([])
      expect(allText(safe)).toContain(PLANTUML_DISABLED_SERVER)

      // Negative control: without the headmatter Slidev points the <img> at plantuml.com, and the
      // post-build scan used by `course build` detects it.
      const leaky = buildPlantUmlProbe('')
      expect(findPlantUmlServerRefs(leaky).length).toBeGreaterThan(0)
    } finally {
      // The probes contain PlantUML blocks; the workspace guard must not see them afterwards.
      cleanup()
    }
  }, 180_000)

  it('`course build` builds the faktura lesson with its Mermaid diagram', () => {
    const result = runBuild({ cwd: workspace })
    expect(result.decks.map((d) => `${d.lessonId}/${d.lang}`)).toEqual([
      '01-architecture/en',
      '01-architecture/pl',
    ])
    const en = allText(path.join(workspace, 'dist', '01-architecture', 'en'))
    // Slidev's built-in Mermaid renders client-side from the diagram source in the bundle.
    expect(en).toMatch(/mermaid/i)
    expect(en).toContain('io.github.kasperone.faktura')
    expect(en).toContain('/01-architecture/en/')
    expect(findPlantUmlServerRefs(path.join(workspace, 'dist'))).toEqual([])
    expect(existsSync(path.join(workspace, 'dist', 'index.html'))).toBe(true)
  }, 180_000)
})
