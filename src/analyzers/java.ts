import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandOnPath, readBlobAtCommit, readTextAtCommit } from '../lib/git-commit.js'
import type { AnalyzerContext, AnalyzerSection, RepoAnalyzer } from './types.js'

function hasJavaSignals(ctx: AnalyzerContext): boolean {
  return ctx.selectedPaths.some(
    (p) => p.endsWith('.java') || p === 'pom.xml' || p.endsWith('/pom.xml') || p === 'build.gradle',
  )
}

function jarOrClassPaths(paths: string[]): string[] {
  return paths.filter((p) => p.endsWith('.jar') || p.endsWith('.class'))
}

function runJdepsMermaid(repo: string, commit: string, artifactPaths: string[]): string | null {
  if (!commandOnPath('jdeps')) return null
  const edges = new Set<string>()
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'course-kit-jdeps-'))
  try {
    for (const rel of artifactPaths.slice(0, 5)) {
      const blob = readBlobAtCommit(repo, commit, rel)
      if (!blob) continue
      const local = path.join(tmpDir, path.basename(rel))
      writeFileSync(local, blob)
      try {
        const summary = execFileSync('jdeps', ['-summary', '-q', local], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        for (const line of summary.split('\n')) {
          const m = line.match(/^(.+?)\s+->\s+(.+)$/)
          if (m) edges.add(`  ${sanitizeId(m[1]!)} --> ${sanitizeId(m[2]!)}`)
        }
      } catch {
        // try next artifact
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  if (edges.size === 0) return null
  return ['flowchart LR', ...edges].join('\n')
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_')
}

function packageImportGraph(ctx: AnalyzerContext): string {
  const packages = new Map<string, Set<string>>()
  const javaFiles = ctx.selectedPaths.filter((p) => p.endsWith('.java'))
  for (const file of javaFiles) {
    const text = ctx.readText(file) ?? readTextAtCommit(ctx.targetRepo, ctx.pinnedCommit, file)
    if (!text) continue
    let pkg = '(default)'
    for (const line of text.split('\n')) {
      const pkgMatch = line.match(/^\s*package\s+([\w.]+)\s*;/)
      if (pkgMatch) pkg = pkgMatch[1]!
      const impMatch = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)\.\w+\s*;/)
      if (impMatch) {
        const targetPkg = impMatch[1]!
        if (!packages.has(pkg)) packages.set(pkg, new Set())
        packages.get(pkg)!.add(targetPkg)
      }
    }
  }
  const lines = ['flowchart LR']
  for (const [from, targets] of packages) {
    for (const to of targets) {
      lines.push(`  ${sanitizeId(from)} --> ${sanitizeId(to)}`)
    }
  }
  return lines.length > 1 ? lines.join('\n') : 'flowchart LR\n  empty[No Java imports parsed]'
}

export const javaAnalyzer: RepoAnalyzer = {
  id: 'java',
  detect: hasJavaSignals,
  analyze: async (ctx): Promise<AnalyzerSection | null> => {
    const jars = jarOrClassPaths(ctx.selectedPaths)
    let mermaid = jars.length > 0 ? runJdepsMermaid(ctx.targetRepo, ctx.pinnedCommit, jars) : null
    let method = 'package-import graph (sources)'
    if (mermaid) {
      method = 'jdeps (compiled artifacts in selection)'
    } else {
      mermaid = packageImportGraph(ctx)
    }

    const markdown = [
      `Java module view (**${method}**).`,
      '',
      '```mermaid',
      mermaid,
      '```',
      '',
    ].join('\n')

    return {
      analyzerId: 'java',
      title: 'Java module / package graph',
      markdown,
    }
  },
}
