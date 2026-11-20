import { existsSync, mkdirSync } from 'node:fs'
import type { CourseJson } from './init.js'
import { defaultLessonJson, writeLessonJson, writePlaceholderSlides } from '../lib/lesson.js'
import { validateLessonId } from '../lib/validate.js'
import { lessonDir, resolveWorkspace } from '../lib/workspace.js'

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
  const { courseDir, course } = resolveWorkspace(options.cwd)
  const root = lessonDir(courseDir, options.lessonId)
  if (existsSync(root)) {
    throw new Error(`Lesson already exists: ${root}`)
  }
  mkdirSync(root, { recursive: true })
  writeLessonJson(root, defaultLessonJson(options.lessonId))
  writePlaceholderSlides(root, options.lessonId, course.languages)
  return { lessonRoot: root, course }
}
