export type AnalyzerArtifact = {
  /** Repo-relative path of a compiled artifact (.jar/.class) matched by the lesson selection. */
  path: string
  size: number
  /** Read the blob at the pinned commit (null if unavailable). */
  read: () => Buffer | null
}

export type AnalyzerContext = {
  pinnedCommit: string
  /** Text files embedded in the pack (repo-relative). */
  selectedPaths: string[]
  /** Text of a selected file as embedded in the pack (secrets already redacted). */
  readText: (filePath: string) => string | null
  /** Compiled artifacts matched by the selection; not embedded in the pack. */
  artifacts: AnalyzerArtifact[]
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
