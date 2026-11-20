import { javaAnalyzer } from './java.js'
import type { AnalyzerContext, AnalyzerSection, RepoAnalyzer } from './types.js'

const analyzers: RepoAnalyzer[] = [javaAnalyzer]

export function runAnalyzers(ctx: AnalyzerContext): Promise<AnalyzerSection[]> {
  const active = analyzers.filter((a) => a.detect(ctx))
  return Promise.all(active.map((a) => a.analyze(ctx))).then((sections) =>
    sections.filter((s): s is AnalyzerSection => s !== null),
  )
}
