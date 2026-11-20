import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildContextPack, defaultPackPaths } from '../lib/context-pack/build.js'
import { readLessonJson } from '../lib/lesson.js'
import { validateLessonId } from '../lib/validate.js'
import { lessonDir, resolveWorkspace } from '../lib/workspace.js'

export type ContextOptions = {
  lessonId: string
  files?: string[]
  out?: string
  json?: boolean
  cwd?: string
}

/** `--out foo.md` -> `foo.json`; any other name gets `.json` appended. */
export function jsonPathFor(markdownPath: string): string {
  return markdownPath.toLowerCase().endsWith('.md')
    ? markdownPath.slice(0, -3) + '.json'
    : markdownPath + '.json'
}

export async function runContext(options: ContextOptions) {
  validateLessonId(options.lessonId)
  const { courseDir, course, targetRepoPath } = resolveWorkspace(options.cwd)
  const root = lessonDir(courseDir, options.lessonId)
  if (!existsSync(root)) {
    throw new Error(`Unknown lesson "${options.lessonId}" (expected ${root})`)
  }
  const lesson = readLessonJson(root)
  const defaults = defaultPackPaths(courseDir, options.lessonId)
  const outMarkdown = options.out ? path.resolve(options.out) : defaults.md
  const outJson = options.json
    ? options.out
      ? jsonPathFor(outMarkdown)
      : defaults.json
    : undefined

  return buildContextPack({
    course,
    repoPath: targetRepoPath,
    lesson,
    cliFileGlobs: options.files ?? [],
    outMarkdown,
    outJson,
  })
}
