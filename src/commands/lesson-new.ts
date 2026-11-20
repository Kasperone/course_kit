import { existsSync, mkdirSync } from 'node:fs'
import type { CourseJson } from './init.js'
import { defaultLessonJson, writeLessonJson, writePlaceholderSlides } from '../lib/lesson.js'
import { lessonDir, resolveWorkspace } from '../lib/workspace.js'

export type LessonNewOptions = {
  lessonId: string
  cwd?: string
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/i

export function validateLessonId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid lesson id "${id}" (use letters, numbers, dots, hyphens)`)
  }
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
