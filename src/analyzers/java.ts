import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fence } from '../lib/context-pack/markdown.js'
import { FlowchartBuilder } from './mermaid.js'
import type { AnalyzerContext, AnalyzerSection, RepoAnalyzer } from './types.js'

/** Runs `jdeps -summary` on a local file; returns stdout or null if jdeps is unavailable/fails. */
export type JdepsRunner = (file: string) => string | null

let jdepsProbe: boolean | undefined

/** jdeps on one jar is seconds; never let a stuck JVM hang `course context`. */
const JDEPS_TIMEOUT_MS = 60_000

function jdepsAvailable(): boolean {
  if (jdepsProbe === undefined) {
    try {
      execFileSync('jdeps', ['-version'], { stdio: 'pipe', timeout: JDEPS_TIMEOUT_MS })
      jdepsProbe = true
    } catch {
      jdepsProbe = false
    }
  }
  return jdepsProbe
}

export const defaultJdepsRunner: JdepsRunner = (file) => {
  if (!jdepsAvailable()) return null
  try {
    return execFileSync('jdeps', ['-summary', '-q', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: JDEPS_TIMEOUT_MS,
    })
  } catch {
    return null
  }
}

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

export function packageImportGraph(ctx: AnalyzerContext): FlowchartBuilder {
  const graph = new FlowchartBuilder()
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
    graph.node(pkg)
    for (const target of imports) graph.edge(pkg, target)
  }
  return graph
}

function jdepsGraph(ctx: AnalyzerContext, runJdeps: JdepsRunner): FlowchartBuilder | null {
  if (ctx.artifacts.length === 0) return null
  const graph = new FlowchartBuilder()
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'course-kit-jdeps-'))
  try {
    ctx.artifacts.forEach((artifact, i) => {
      const blob = artifact.read()
      if (!blob) return
      // Index prefix keeps same-named artifacts from different directories apart.
      const local = path.join(tmpDir, `${i}-${path.posix.basename(artifact.path)}`)
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
      let method = 'package-import graph (sources)'
      let graph = jdepsGraph(ctx, runJdeps)
      if (graph) {
        method = `jdeps (${ctx.artifacts.length} compiled artifact(s) in selection)`
      } else {
        graph = packageImportGraph(ctx)
      }
      const mermaid = graph.isEmpty
        ? 'flowchart LR\n  empty["No Java packages parsed"]'
        : graph.render('LR')
      return {
        analyzerId: 'java',
        title: 'Java module / package graph',
        markdown: [`Java module view (**${method}**).`, '', fence(mermaid, 'mermaid'), ''].join(
          '\n',
        ),
      }
    },
  }
}

export const javaAnalyzer = createJavaAnalyzer()
