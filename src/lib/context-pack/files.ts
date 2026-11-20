import { minimatch } from 'minimatch'
import type { TreeEntry } from '../git-commit.js'
import { DEFAULT_LESSON_GLOBS } from '../lesson.js'
import { isProbablyBinaryPath, type PackLimits } from './limits.js'

export type SkipReason = 'sensitive' | 'binary' | 'too-large' | 'over-cap' | 'symlink' | 'submodule'

export type Skipped = { path: string; reason: SkipReason; detail?: string }

/** Compiled artifacts (jar/class) are binary but useful to analyzers such as jdeps. */
export const MAX_ARTIFACTS = 5
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024

export type Selection = {
  /** Text files to embed, in output order (literal files first, then glob matches). */
  included: TreeEntry[]
  /** Matched .jar/.class blobs handed to analyzers (not embedded). */
  artifacts: TreeEntry[]
  skipped: Skipped[]
  /** Number of distinct paths matched by `files` + globs before any filtering. */
  matched: number
  /** `files` entries that do not exist at the pinned commit. */
  missingFiles: string[]
  /** Glob patterns that matched nothing. */
  unmatchedGlobs: string[]
}

export type SelectionInput = {
  files: string[]
  globs: string[]
  cliGlobs: string[]
}

export function isArtifactPath(p: string): boolean {
  return /\.(jar|class)$/i.test(p)
}

/**
 * Pick files for the pack. `files` are exact paths (so `app/[id]/page.tsx` works); `globs` and
 * CLI globs go through minimatch. Nothing is dropped silently: every matched path is either
 * included or listed in `skipped` with a reason.
 */
export function selectEntries(
  tree: TreeEntry[],
  input: SelectionInput,
  limits: PackLimits,
  isSensitive: (p: string) => string | null = () => null,
): Selection {
  const byPath = new Map(tree.map((e) => [e.path, e]))
  const files = [...new Set(input.files)]
  let globs = [...new Set([...input.globs, ...input.cliGlobs])]
  if (files.length === 0 && globs.length === 0) globs = [...DEFAULT_LESSON_GLOBS]

  const missingFiles = files.filter((f) => !byPath.has(f))
  const literal = files.filter((f) => byPath.has(f))
  const literalSet = new Set(literal)
  const unmatchedGlobs = new Set(globs)
  const globMatches: string[] = []
  for (const entry of tree) {
    if (literalSet.has(entry.path)) continue
    const hit = globs.filter((g) => minimatch(entry.path, g, { dot: true }))
    if (hit.length === 0) continue
    for (const g of hit) unmatchedGlobs.delete(g)
    globMatches.push(entry.path)
  }
  globMatches.sort()

  const selection: Selection = {
    included: [],
    artifacts: [],
    skipped: [],
    matched: literal.length + globMatches.length,
    missingFiles,
    unmatchedGlobs: [...unmatchedGlobs],
  }

  for (const p of [...literal, ...globMatches]) {
    const entry = byPath.get(p)!
    const skip = (reason: SkipReason, detail?: string) =>
      selection.skipped.push(detail ? { path: p, reason, detail } : { path: p, reason })
    if (entry.type === 'commit') {
      skip('submodule')
      continue
    }
    const sensitive = isSensitive(p)
    if (sensitive) {
      skip('sensitive', sensitive)
      continue
    }
    if (entry.symlink) {
      skip('symlink')
      continue
    }
    if (isArtifactPath(p)) {
      if ((entry.size ?? 0) > MAX_ARTIFACT_BYTES) skip('too-large', `${entry.size} bytes`)
      else if (selection.artifacts.length >= MAX_ARTIFACTS) skip('over-cap', 'artifacts')
      else selection.artifacts.push(entry)
      continue
    }
    if (isProbablyBinaryPath(p)) {
      skip('binary')
      continue
    }
    if ((entry.size ?? 0) > limits.maxFileBytes) {
      skip('too-large', `${entry.size} bytes > maxFileBytes ${limits.maxFileBytes}`)
      continue
    }
    if (selection.included.length >= limits.maxSelectedFiles) {
      skip('over-cap', `maxSelectedFiles ${limits.maxSelectedFiles}`)
      continue
    }
    selection.included.push(entry)
  }
  return selection
}
