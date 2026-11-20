import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveCourseTargetRepo, type CourseJson } from '../commands/init.js'

export type Workspace = {
  courseDir: string
  course: CourseJson
}

export function resolveWorkspace(cwd: string = process.cwd()): Workspace {
  const courseDir = path.resolve(cwd)
  const coursePath = path.join(courseDir, 'course.json')
  if (!existsSync(coursePath)) {
    throw new Error(
      `Not a course workspace (missing course.json). Run from a workspace directory or use course init.`,
    )
  }
  const course = JSON.parse(readFileSync(coursePath, 'utf8')) as CourseJson
  if (!course.targetRepo || !course.pinnedCommit) {
    throw new Error('Invalid course.json: targetRepo and pinnedCommit are required')
  }
  // course.json stores targetRepo relative to the workspace; resolve it for in-process use.
  return {
    courseDir,
    course: { ...course, targetRepo: resolveCourseTargetRepo(courseDir, course.targetRepo) },
  }
}

export function lessonDir(courseDir: string, lessonId: string): string {
  return path.join(courseDir, 'lessons', lessonId)
}
