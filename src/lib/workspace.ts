import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveCourseTargetRepo, TARGET_REPO_ENV, type CourseJson } from '../commands/init.js'
import { parseChatSettings } from './chat/config.js'
import { FULL_SHA_RE } from './git.js'
import { validateAudioQuality } from './narration/quality.js'
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
  /** course.json as written (targetRepo is workspace-relative or null). */
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
  const targetRepo = raw.targetRepo ?? null
  if (targetRepo !== null && (typeof targetRepo !== 'string' || targetRepo.trim() === '')) {
    throw new Error(`${file}: "targetRepo" must be a non-empty path or null`)
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
  const course: CourseJson = {
    schemaVersion: 1,
    targetRepo,
    targetRemote: remote,
    pinnedCommit: raw.pinnedCommit,
    languages,
    referenceMode,
    submodulePath,
  }
  if (raw.audioQuality !== undefined) {
    course.audioQuality = validateAudioQuality(raw.audioQuality, `${file}: "audioQuality"`)
  }
  if (raw.chat !== undefined) course.chat = parseChatSettings(raw.chat, `${file}: "chat"`)
  return course
}

function physical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Same device and inode: the same directory however its path is spelled (case, bind mount, ...). */
type StatFn = (p: string) => { dev: number | bigint; ino: number | bigint }

/**
 * True if `target` or one of its ancestors is the workspace directory itself, by identity. A path
 * comparison alone is case-sensitive: on a case-insensitive filesystem `../MY-COURSE/evil` is inside
 * a workspace cloned as `my-course/`, and the strings differ. Walks up from the target's real path.
 */
export function targetIsInsideByIdentity(
  courseDir: string,
  target: string,
  stat: StatFn = (p) => statSync(p),
): boolean {
  let workspace: ReturnType<StatFn>
  try {
    workspace = stat(courseDir)
  } catch {
    return false
  }
  let dir = physical(target)
  for (;;) {
    try {
      const s = stat(dir)
      if (s.ino === workspace.ino && s.dev === workspace.dev) return true
    } catch {
      // not there (yet): keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Refuse a target inside the workspace unless it is the submodule. course.json and even the
 * gitignored course.local.json come with a shared workspace, so they could point at repository
 * files planted in it (e.g. a committed bare repo whose config runs programs). The path check
 * and the identity check back each other up, and `safe.bareRepository=explicit` backs up both.
 */
export function assertTargetOutsideWorkspace(
  courseDir: string,
  target: string,
  stat?: StatFn,
): void {
  const rel = path.relative(physical(courseDir), physical(target))
  const inside =
    rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
  if (inside || targetIsInsideByIdentity(courseDir, target, stat)) {
    throw new Error(
      `Target repo ${target} is inside the course workspace. Use --submodule mode, or set ${TARGET_REPO_ENV} to a clone outside it.`,
    )
  }
}

/**
 * Where to read the pinned commit from: COURSE_TARGET_REPO if set; the checked-out submodule in
 * submodule mode; otherwise course.local.json, then course.json `targetRepo` resolved against the
 * workspace (never inside it).
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
  const target = resolveCourseTargetRepo(courseDir, course.targetRepo)
  assertTargetOutsideWorkspace(courseDir, target)
  return target
}

/** Workspace directory and validated course.json, without locating the target repo. */
export function resolveWorkspaceConfig(cwd: string = process.cwd()): {
  courseDir: string
  course: CourseJson
} {
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
  return { courseDir, course }
}

export function resolveWorkspace(cwd: string = process.cwd()): Workspace {
  const { courseDir, course } = resolveWorkspaceConfig(cwd)
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
