import { checkoutSubmoduleCommit, resolveCommit, uncommittedWarning } from '../lib/git.js'
import { verifyCommit } from '../lib/git-commit.js'
import { resolveWorkspace } from '../lib/workspace.js'
import { writeCourseJson } from './init.js'

export type PinOptions = {
  /** Revision to pin (branch, tag, short or full SHA). Default: the target repo's HEAD. */
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
 * lock-free `git status`); in submodule mode the workspace's own submodule checkout is moved.
 */
export function runPin(options: PinOptions = {}): PinResult {
  const { courseDir, course, targetRepoPath } = resolveWorkspace(options.cwd)
  const pinned = resolveCommit(targetRepoPath, options.commit ?? 'HEAD')
  verifyCommit(targetRepoPath, pinned)

  const warnings: string[] = []
  const dirty = uncommittedWarning(targetRepoPath, pinned)
  if (dirty) warnings.push(dirty)

  const previous = course.pinnedCommit
  const changed = previous !== pinned
  if (changed) {
    if (course.referenceMode === 'submodule' && course.submodulePath) {
      checkoutSubmoduleCommit(courseDir, course.submodulePath, pinned)
    }
    writeCourseJson(courseDir, { ...course, pinnedCommit: pinned })
    warnings.push(
      'Context packs built from the previous commit are stale; re-run `course context <lesson-id>`.',
    )
  }
  return { courseDir, previous, pinned, changed, warnings }
}
