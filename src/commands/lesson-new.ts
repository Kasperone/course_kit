import { existsSync } from 'node:fs'
import { mkdirInside } from '../lib/fs-safe.js'
import type { CourseJson } from './init.js'
import { defaultLessonJson, writeLessonJson, writePlaceholderSlides } from '../lib/lesson.js'
import { validateLessonId } from '../lib/validate.js'
import { lessonDir, resolveWorkspaceConfig } from '../lib/workspace.js'

export { validateLessonId }

export type LessonNewOptions = {
  lessonId: string
  cwd?: string
}

export function runLessonNew(options: LessonNewOptions): {
  lessonRoot: string
  course: CourseJson
} {
  validateLessonId(options.lessonId)
  // Only course.json is needed: a fresh clone without the target (or its submodule) works too.
  const { courseDir, course } = resolveWorkspaceConfig(options.cwd)
  const root = lessonDir(courseDir, options.lessonId)
  if (existsSync(root)) {
    throw new Error(`Lesson already exists: ${root}`)
  }
  mkdirInside(courseDir, root)
  writeLessonJson(root, defaultLessonJson(options.lessonId))
  writePlaceholderSlides(root, options.lessonId, course.languages)
  return { lessonRoot: root, course }
}
