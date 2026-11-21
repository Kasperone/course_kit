import path from 'node:path'
import {
  checkoutSubmoduleCommit,
  fetchSubmoduleOrigin,
  resolveCommit,
  uncommittedWarning,
} from '../lib/git.js'
import { verifyCommit } from '../lib/git-commit.js'
import { resolveWorkspace } from '../lib/workspace.js'
import { writeCourseJson } from './init.js'

export type PinOptions = {
  /**
   * Revision to pin (branch, tag, short or full SHA). Default: the target repo's HEAD; in submodule
   * mode, the HEAD of the submodule's origin.
   */
  commit?: string
  cwd?: string
}

export type PinResult = {
  courseDir: string
  previous: string
  pinned: string
  changed: boolean
  warnings: string[]
}

/**
 * `course pin`: resolve a revision in the target repo to a full SHA, verify the commit exists and
 * store it as course.json `pinnedCommit`. The target repo is only read (rev-parse, cat-file and a
 * lock-free `git status`). In submodule mode the workspace's own submodule is fetched from its
 * origin first (its HEAD is the old pin) and its checkout is moved.
 */
export function runPin(options: PinOptions = {}): PinResult {
  const { courseDir, course, targetRepoPath } = resolveWorkspace(options.cwd)
  const submodule =
    course.referenceMode === 'submodule' && course.submodulePath
      ? path.join(courseDir, course.submodulePath)
      : null
  // COURSE_TARGET_REPO can point elsewhere; only the submodule checkout itself needs the fetch.
  const inSubmodule = submodule !== null && path.resolve(targetRepoPath) === path.resolve(submodule)
  const remoteHead = inSubmodule ? fetchSubmoduleOrigin(targetRepoPath) : null
  const pinned = options.commit
    ? resolveCommit(targetRepoPath, options.commit)
    : (remoteHead ?? resolveCommit(targetRepoPath, 'HEAD'))
  verifyCommit(targetRepoPath, pinned)

  const warnings: string[] = []
  const dirty = uncommittedWarning(targetRepoPath, pinned)
  if (dirty) warnings.push(dirty)

  const previous = course.pinnedCommit
  const changed = previous !== pinned
  if (changed) {
    // course.json first: if it cannot be written (e.g. it is a symlink), nothing has moved yet.
    writeCourseJson(courseDir, { ...course, pinnedCommit: pinned })
    if (course.referenceMode === 'submodule' && course.submodulePath) {
      try {
        checkoutSubmoduleCommit(courseDir, course.submodulePath, pinned)
      } catch (err) {
        writeCourseJson(courseDir, course)
        throw err
      }
    }
    warnings.push(
      'Context packs built from the previous commit are stale; re-run `course context <lesson-id>`.',
    )
  }
  return { courseDir, previous, pinned, changed, warnings }
}
