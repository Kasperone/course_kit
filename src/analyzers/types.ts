export type AnalyzerContext = {
  targetRepo: string
  pinnedCommit: string
  selectedPaths: string[]
  readText: (filePath: string) => string | null
}

export type AnalyzerSection = {
  analyzerId: string
  title: string
  markdown: string
}

export type RepoAnalyzer = {
  id: string
  detect: (ctx: AnalyzerContext) => boolean
  analyze: (ctx: AnalyzerContext) => Promise<AnalyzerSection | null>
}
