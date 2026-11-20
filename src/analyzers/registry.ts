import { javaAnalyzer } from './java.js'
import type { AnalyzerContext, AnalyzerSection, RepoAnalyzer } from './types.js'

export const defaultAnalyzers: RepoAnalyzer[] = [javaAnalyzer]

export async function runAnalyzers(
  ctx: AnalyzerContext,
  analyzers: RepoAnalyzer[] = defaultAnalyzers,
): Promise<AnalyzerSection[]> {
  const active = analyzers.filter((a) => a.detect(ctx))
  const sections = await Promise.all(active.map((a) => a.analyze(ctx)))
  return sections.filter((s): s is AnalyzerSection => s !== null)
}
