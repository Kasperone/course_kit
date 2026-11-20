import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runAnalyzers } from '../../analyzers/registry.js'
import type { CourseJson } from '../../commands/init.js'
import { listTrackedPathsAtCommit, logTouchingPaths, readTextAtCommit } from '../git-commit.js'
import type { LessonJson } from '../lesson.js'
import { buildDocExcerpts } from './docs.js'
import { estimateTokens } from './estimate.js'
import { collectSelectedPaths, mergeFilePatterns } from './files.js'
import { PACK_LIMITS } from './limits.js'
import { findRelatedTests } from './tests-heuristic.js'
import { buildTreeSummary } from './tree.js'

export type ContextPackMeta = {
  schemaVersion: 1
  lessonId: string
  targetRepo: string
  targetRemote: string | null
  pinnedCommit: string
  generatedAt: string
  selectedFiles: string[]
  relatedTests: string[]
  analyzers: string[]
  bytes: number
  tokenEstimate: number
}

export type BuildContextPackOptions = {
  course: CourseJson
  /** Absolute path of the repository to read the pinned commit from. */
  repoPath: string
  lesson: LessonJson
  cliFileGlobs: string[]
  outMarkdown: string
  outJson?: string
}

function numberedExcerpt(content: string, maxLines: number): string {
  const lines = content.split('\n')
  const slice = lines.slice(0, maxLines)
  return slice.map((line, i) => `${String(i + 1).padStart(6, ' ')}|${line}`).join('\n')
}

export async function buildContextPack(opts: BuildContextPackOptions): Promise<ContextPackMeta> {
  const { course, lesson, cliFileGlobs, outMarkdown, outJson } = opts
  const repo = opts.repoPath
  const commit = course.pinnedCommit
  const allPaths = listTrackedPathsAtCommit(repo, commit)
  const patterns = mergeFilePatterns(lesson.files, lesson.globs, cliFileGlobs)
  const selected = collectSelectedPaths(allPaths, patterns, repo, commit)
  const relatedTests = findRelatedTests(selected, allPaths)
  const filesForContent = [...new Set([...selected, ...relatedTests])].sort()

  const readText = (filePath: string) => readTextAtCommit(repo, commit, filePath)

  const fileSections: string[] = []
  for (const filePath of filesForContent) {
    const text = readText(filePath)
    if (text === null) {
      fileSections.push(`### \`${filePath}\`\n\n_Skipped (binary or unreadable at commit)._\n`)
      continue
    }
    const excerpt = numberedExcerpt(text, PACK_LIMITS.maxLinesPerFile)
    fileSections.push(
      `### \`${filePath}\``,
      '',
      '```',
      excerpt,
      text.split('\n').length > PACK_LIMITS.maxLinesPerFile ? '… truncated' : '',
      '```',
      '',
    )
  }

  const logLines = logTouchingPaths(repo, commit, selected, PACK_LIMITS.maxLogEntries)
  const analyzerSections = await runAnalyzers({
    targetRepo: repo,
    pinnedCommit: commit,
    selectedPaths: selected,
    readText,
  })

  const generatedAt = new Date().toISOString()
  const header = [
    '# Context pack',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Lesson | \`${lesson.id}\` |`,
    `| Target repo | \`${course.targetRepo}\` (relative to the workspace) |`,
    `| Target remote | ${course.targetRemote ? `\`${course.targetRemote}\`` : '_none_'} |`,
    `| Pinned commit | \`${commit}\` |`,
    `| Generated | ${generatedAt} |`,
    '',
  ]
  if (lesson.focus) {
    header.push('## Focus', '', lesson.focus, '')
  }
  if (lesson.notes) {
    header.push('## Notes', '', lesson.notes, '')
  }

  const parts = [
    ...header,
    '## Repository tree (pinned commit)',
    '',
    buildTreeSummary(allPaths),
    '',
    '## Project docs (excerpts)',
    '',
    buildDocExcerpts(repo, commit),
    '## Selected sources (line-numbered)',
    '',
    ...fileSections,
    '## Related tests (heuristic)',
    '',
    relatedTests.length
      ? relatedTests.map((t) => `- \`${t}\``).join('\n')
      : '_None matched heuristics._',
    '',
    '## Recent history (selected paths)',
    '',
    logLines.length ? logLines.map((l) => `- ${l}`).join('\n') : '_No log entries._',
    '',
    '## Language-specific analysis',
    '',
    analyzerSections.length
      ? analyzerSections.map((s) => `### ${s.title}\n\n${s.markdown}`).join('\n')
      : '_No analyzer matched this selection._',
    '',
  ]

  const body = parts.join('\n')
  const bytes = Buffer.byteLength(body, 'utf8')
  const tokens = estimateTokens(body)
  const markdown = [
    body,
    '## Size estimate',
    '',
    `**${bytes}** bytes, **~${tokens}** tokens (characters ÷ 4 heuristic).`,
    '',
  ].join('\n')
  writeFileSync(outMarkdown, markdown, 'utf8')

  const meta: ContextPackMeta = {
    schemaVersion: 1,
    lessonId: lesson.id,
    targetRepo: course.targetRepo,
    targetRemote: course.targetRemote,
    pinnedCommit: commit,
    generatedAt,
    selectedFiles: selected,
    relatedTests,
    analyzers: analyzerSections.map((s) => s.analyzerId),
    bytes: Buffer.byteLength(markdown, 'utf8'),
    tokenEstimate: estimateTokens(markdown),
  }

  if (outJson) {
    writeFileSync(outJson, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  }

  return meta
}

export function defaultPackPaths(
  courseDir: string,
  lessonId: string,
): { md: string; json: string } {
  const base = path.join(courseDir, 'lessons', lessonId)
  return {
    md: path.join(base, 'context-pack.md'),
    json: path.join(base, 'context-pack.json'),
  }
}
