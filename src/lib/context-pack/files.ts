import { minimatch } from 'minimatch'
import { isProbablyBinaryPath, PACK_LIMITS } from './limits.js'
import { blobSizeAtCommit } from '../git-commit.js'

export function collectSelectedPaths(
  allPaths: string[],
  patterns: string[],
  repo: string,
  commit: string,
): string[] {
  const uniquePatterns = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))]
  if (uniquePatterns.length === 0) {
    return allPaths.filter((p) => p === 'README.md' || p === 'readme.md').slice(0, 5)
  }

  const selected: string[] = []
  for (const filePath of allPaths) {
    if (isProbablyBinaryPath(filePath)) continue
    const size = blobSizeAtCommit(repo, commit, filePath)
    if (size > PACK_LIMITS.maxFileBytes) continue
    const matched = uniquePatterns.some((pat) => minimatch(filePath, pat, { dot: true }))
    if (matched) selected.push(filePath)
    if (selected.length >= PACK_LIMITS.maxSelectedFiles) break
  }
  return selected.sort()
}

export function mergeFilePatterns(
  lessonFiles: string[],
  lessonGlobs: string[],
  cliGlobs: string[],
): string[] {
  const merged = [...lessonFiles, ...lessonGlobs, ...cliGlobs]
  if (merged.length > 0) return merged
  return ['README.md', '**/*']
}
