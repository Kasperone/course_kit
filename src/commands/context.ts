import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildContextPack, defaultPackPaths } from '../lib/context-pack/build.js'
import { readLessonJson } from '../lib/lesson.js'
import { lessonDir, resolveWorkspace } from '../lib/workspace.js'

export type ContextOptions = {
  lessonId: string
  files?: string[]
  out?: string
  json?: boolean
  cwd?: string
}

export async function runContext(options: ContextOptions) {
  const { courseDir, course } = resolveWorkspace(options.cwd)
  const root = lessonDir(courseDir, options.lessonId)
  if (!existsSync(root)) {
    throw new Error(`Unknown lesson "${options.lessonId}" (expected ${root})`)
  }
  const lesson = readLessonJson(root)
  const defaults = defaultPackPaths(courseDir, options.lessonId)
  const outMarkdown = path.resolve(options.out ?? defaults.md)
  const outJson = options.json ? defaults.json : undefined

  return buildContextPack({
    course,
    lesson,
    cliFileGlobs: options.files ?? [],
    outMarkdown,
    outJson,
  })
}
