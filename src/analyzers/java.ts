import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { childEnv } from '../lib/child-env.js'
import { fence, inlineCode } from '../lib/context-pack/markdown.js'
import { isTestPath } from '../lib/context-pack/tests-heuristic.js'
import { FlowchartBuilder } from './mermaid.js'
import type { AnalyzerContext, AnalyzerSection, RepoAnalyzer } from './types.js'

/**
 * Runs `jdeps -summary` on a local file; returns stdout or null if jdeps fails. `available` (when
 * present) says whether jdeps can run at all, so no artifact is read or copied to disk without it.
 */
export type JdepsRunner = ((file: string) => string | null) & { available?: () => boolean }

/** jdeps finds its JDK through PATH or JAVA_HOME; nothing else of the environment is needed. */
const jdepsEnv = () => childEnv({ extra: ['JAVA_HOME'] })

let jdepsProbe: boolean | undefined

/** jdeps on one jar is seconds; never let a stuck JVM hang `course context`. */
const JDEPS_TIMEOUT_MS = 60_000

function jdepsAvailable(): boolean {
  if (jdepsProbe === undefined) {
    try {
      execFileSync('jdeps', ['-version'], {
        stdio: 'pipe',
        timeout: JDEPS_TIMEOUT_MS,
        env: jdepsEnv(),
      })
      jdepsProbe = true
    } catch {
      jdepsProbe = false
    }
  }
  return jdepsProbe
}

export const defaultJdepsRunner: JdepsRunner = (file) => {
  try {
    return execFileSync('jdeps', ['-summary', '-q', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: JDEPS_TIMEOUT_MS,
      env: jdepsEnv(),
    })
  } catch {
    return null
  }
}
defaultJdepsRunner.available = jdepsAvailable

/** Parse `jdeps -summary` lines such as `app.jar -> java.base`. */
export function parseJdepsSummary(output: string): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\S.*?)\s+->\s+(\S.*?)\s*$/)
    if (m) edges.push([m[1]!, m[2]!])
  }
  return edges
}

const JAVA_BUILD_FILES = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/

function hasJavaSignals(ctx: AnalyzerContext): boolean {
  return (
    ctx.artifacts.length > 0 ||
    ctx.selectedPaths.some((p) => p.endsWith('.java') || JAVA_BUILD_FILES.test(p))
  )
}

/**
 * Package of an import target: segments before the first capitalised segment (the class), so
 * `a.b.C`, `a.b.C.Inner`, `static a.b.C.m` and `a.b.C.*` all map to `a.b`; `a.b.*` maps to `a.b`.
 */
export function importedPackage(name: string, wildcard: boolean, isStatic: boolean): string {
  const segs = name.split('.')
  const firstClass = segs.findIndex((s) => /^[A-Z]/.test(s))
  if (firstClass > 0) return segs.slice(0, firstClass).join('.')
  if (wildcard) return isStatic ? segs.slice(0, -1).join('.') : name
  return segs.slice(0, isStatic ? -2 : -1).join('.')
}

const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/
const IMPORT_RE = /^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/

export type JavaSource = { path: string; pkg: string; imports: string[]; test: boolean }

/** Package declaration and imported packages of every selected `.java` file. */
export function parseJavaSources(ctx: AnalyzerContext): JavaSource[] {
  const sources: JavaSource[] = []
  for (const file of ctx.selectedPaths.filter((p) => p.endsWith('.java'))) {
    const text = ctx.readText(file)
    if (!text) continue
    let pkg = '(default package)'
    const imports: string[] = []
    for (const line of text.split('\n')) {
      const p = line.match(PACKAGE_RE)
      if (p) pkg = p[1]!
      const m = line.match(IMPORT_RE)
      if (m) {
        const target = importedPackage(m[2]!, Boolean(m[3]), Boolean(m[1]))
        if (target) imports.push(target)
      }
    }
    sources.push({ path: file, pkg, imports, test: isTestPath(file) })
  }
  return sources
}

/** Every package and every import edge (externals included). */
export function packageImportGraph(ctx: AnalyzerContext): FlowchartBuilder {
  const graph = new FlowchartBuilder()
  for (const src of parseJavaSources(ctx)) {
    graph.node(src.pkg)
    for (const target of src.imports) graph.edge(src.pkg, target)
  }
  return graph
}

/** Longest common dotted prefix (at least two segments) of several packages, or null. */
export function commonPackagePrefix(packages: string[]): string | null {
  if (packages.length === 0) return null
  let common = packages[0]!.split('.')
  for (const pkg of packages.slice(1)) {
    const segs = pkg.split('.')
    let i = 0
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++
    common = common.slice(0, i)
  }
  return common.length >= 2 ? common.join('.') : null
}

export type OwnPackageGraph = {
  graph: FlowchartBuilder
  /** Packages declared by the analysed sources. */
  ownPackages: string[]
  sourceFiles: number
  /** True when test sources were left out because main sources exist. */
  testsExcluded: boolean
  /** Imported packages outside the repo, collapsed to their first two segments, with counts. */
  externalGroups: Array<{ group: string; importers: number }>
}

/**
 * Graph limited to the repository's own packages (those declared by the selected sources). Test
 * sources are left out when main sources exist; imports of other packages are collapsed into
 * groups such as `org.springframework` and reported next to the graph instead of inside it.
 */
export function ownPackageGraph(ctx: AnalyzerContext): OwnPackageGraph {
  const all = parseJavaSources(ctx)
  const main = all.filter((s) => !s.test)
  const sources = main.length > 0 ? main : all
  const own = new Set(sources.map((s) => s.pkg))
  const ownPrefixes = new Set([...own].map((p) => p.split('.').slice(0, 2).join('.')))
  const graph = new FlowchartBuilder()
  const external = new Map<string, Set<string>>()
  for (const pkg of [...own].sort()) graph.node(pkg)
  for (const src of sources) {
    for (const target of src.imports) {
      if (own.has(target)) {
        graph.edge(src.pkg, target)
      } else {
        // Collapse e.g. org.springframework.web -> org.springframework, but keep packages under
        // the repo's own prefix whole so they cannot be mistaken for an own package.
        const prefix = target.split('.').slice(0, 2).join('.')
        const group = ownPrefixes.has(prefix) ? target : prefix
        external.set(group, (external.get(group) ?? new Set()).add(src.pkg))
      }
    }
  }
  return {
    graph,
    ownPackages: [...own].sort(),
    sourceFiles: sources.length,
    testsExcluded: sources.length < all.length,
    externalGroups: [...external]
      .map(([group, importers]) => ({ group, importers: importers.size }))
      .sort((a, b) => (a.group < b.group ? -1 : 1)),
  }
}

function jdepsGraph(ctx: AnalyzerContext, runJdeps: JdepsRunner): FlowchartBuilder | null {
  if (ctx.artifacts.length === 0) return null
  // Probe before reading: blobs of up to 5 x 20 MB are not copied to tmp without a JDK.
  if (runJdeps.available && !runJdeps.available()) return null
  const graph = new FlowchartBuilder()
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'course-kit-jdeps-'))
  try {
    ctx.artifacts.forEach((artifact, i) => {
      const blob = artifact.read()
      if (!blob) return
      // The name comes from the index and a sanitised extension only: repository file names are
      // never used (a `\` is a separator on Windows, and jdeps keys its output by this name).
      const ext = path.posix.extname(artifact.path).toLowerCase()
      const local = path.join(tmpDir, `${i}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`)
      writeFileSync(local, blob)
      const out = runJdeps(local)
      if (!out) return
      for (const [from, to] of parseJdepsSummary(out)) {
        // Replace the temp file name with the repo path in the graph.
        graph.edge(from === path.basename(local) ? artifact.path : from, to)
      }
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  return graph.isEmpty ? null : graph
}

export function createJavaAnalyzer(runJdeps: JdepsRunner = defaultJdepsRunner): RepoAnalyzer {
  return {
    id: 'java',
    detect: hasJavaSignals,
    analyze: async (ctx): Promise<AnalyzerSection | null> => {
      const jdeps = jdepsGraph(ctx, runJdeps)
      if (jdeps) {
        const method = `jdeps (${ctx.artifacts.length} compiled artifact(s) in selection)`
        return {
          analyzerId: 'java',
          title: 'Java module / package graph',
          markdown: [
            `Java module view (**${method}**).`,
            '',
            fence(jdeps.render('LR'), 'mermaid'),
            '',
          ].join('\n'),
        }
      }
      const own = ownPackageGraph(ctx)
      const prefix = commonPackagePrefix(own.ownPackages)
      const mermaid = own.graph.isEmpty
        ? 'flowchart LR\n  empty["No Java packages parsed"]'
        : prefix && own.ownPackages.length > 1
          ? // LR keeps a subgraph of unconnected packages in one row (TB stacks them).
            own.graph.render('LR', { groupPrefix: prefix })
          : own.graph.render('LR')
      const lines = [
        `Java package view (**package-import graph (sources)**), limited to the repository's own ` +
          `packages: ${own.ownPackages.length} package(s) declared in ${own.sourceFiles} ` +
          `${own.testsExcluded ? 'main ' : ''}source file(s). Edges are imports between own packages` +
          `${own.testsExcluded ? '; test sources are excluded' : ''}.`,
        '',
        fence(mermaid, 'mermaid'),
        '',
      ]
      if (own.externalGroups.length > 0) {
        lines.push(
          'External imports (collapsed, not drawn): ' +
            own.externalGroups
              .map((g) => `${inlineCode(g.group)} (${g.importers} package(s))`)
              .join(', ') +
            '.',
          '',
        )
      }
      return {
        analyzerId: 'java',
        title: 'Java package graph (own packages)',
        markdown: lines.join('\n'),
      }
    },
  }
}

export const javaAnalyzer = createJavaAnalyzer()
