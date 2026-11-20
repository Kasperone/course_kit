import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveCourseTargetRepo, TARGET_REPO_ENV, type CourseJson } from '../commands/init.js'
import { FULL_SHA_RE } from './git.js'
import {
  assertInside,
  isPlainObject,
  readJsonFile,
  validateLanguages,
  validateLessonId,
  validateRelativeDir,
} from './validate.js'

export type Workspace = {
  courseDir: string
  /** course.json as written (targetRepo is workspace-relative). */
  course: CourseJson
  /** Absolute path of the git repository that holds the pinned commit. */
  targetRepoPath: string
}

/** Parse and validate course.json; never trust a shared or hand-edited file. */
export function parseCourseJson(raw: unknown, file: string): CourseJson {
  if (!isPlainObject(raw)) throw new Error(`${file}: expected a JSON object`)
  if (raw.schemaVersion !== 1) {
    throw new Error(`${file}: unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}`)
  }
  if (typeof raw.targetRepo !== 'string' || raw.targetRepo.trim() === '') {
    throw new Error(`${file}: "targetRepo" must be a non-empty path`)
  }
  if (typeof raw.pinnedCommit !== 'string' || !FULL_SHA_RE.test(raw.pinnedCommit)) {
    throw new Error(
      `${file}: "pinnedCommit" must be a full lowercase commit SHA (40 or 64 hex characters), got ${JSON.stringify(raw.pinnedCommit)}`,
    )
  }
  const remote = raw.targetRemote ?? null
  if (remote !== null && typeof remote !== 'string') {
    throw new Error(`${file}: "targetRemote" must be a string or null`)
  }
  let languages: string[]
  try {
    languages = validateLanguages(raw.languages)
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const referenceMode = raw.referenceMode ?? 'pinned-path'
  if (referenceMode !== 'pinned-path' && referenceMode !== 'submodule') {
    throw new Error(`${file}: "referenceMode" must be "pinned-path" or "submodule"`)
  }
  const submodulePath =
    referenceMode === 'submodule'
      ? validateRelativeDir(raw.submodulePath, `${file}: "submodulePath"`)
      : null
  return {
    schemaVersion: 1,
    targetRepo: raw.targetRepo,
    targetRemote: remote,
    pinnedCommit: raw.pinnedCommit,
    languages,
    referenceMode,
    submodulePath,
  }
}

/**
 * Where to read the pinned commit from: COURSE_TARGET_REPO if set; the checked-out submodule in
 * submodule mode; otherwise course.json `targetRepo` resolved against the workspace.
 */
export function resolveTargetRepoPath(courseDir: string, course: CourseJson): string {
  if (process.env[TARGET_REPO_ENV]) return resolveCourseTargetRepo(courseDir, course.targetRepo)
  if (course.referenceMode === 'submodule' && course.submodulePath) {
    const sub = path.join(courseDir, course.submodulePath)
    assertInside(courseDir, sub, 'submodulePath')
    if (!existsSync(path.join(sub, '.git'))) {
      throw new Error(
        `Submodule ${course.submodulePath}/ is not checked out. Run: git submodule update --init ${course.submodulePath}`,
      )
    }
    return sub
  }
  return resolveCourseTargetRepo(courseDir, course.targetRepo)
}

export function resolveWorkspace(cwd: string = process.cwd()): Workspace {
  const courseDir = path.resolve(cwd)
  const coursePath = path.join(courseDir, 'course.json')
  if (!existsSync(coursePath)) {
    throw new Error(
      `Not a course workspace (missing course.json). Run from a workspace directory or use course init.`,
    )
  }
  const course = parseCourseJson(
    readJsonFile(coursePath, readFileSync(coursePath, 'utf8')),
    coursePath,
  )
  return { courseDir, course, targetRepoPath: resolveTargetRepoPath(courseDir, course) }
}

/** `lessons/<id>` for a validated id; never resolves outside `lessons/`. */
export function lessonDir(courseDir: string, lessonId: string): string {
  validateLessonId(lessonId)
  const lessonsRoot = path.join(courseDir, 'lessons')
  const dir = path.join(lessonsRoot, lessonId)
  assertInside(lessonsRoot, dir, 'Lesson directory')
  return dir
}
