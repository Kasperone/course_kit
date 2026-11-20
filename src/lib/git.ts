import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function resolveTargetRepo(repoPath: string): string {
  const resolved = path.resolve(repoPath)
  if (!existsSync(resolved)) {
    throw new Error(`Target path does not exist: ${resolved}`)
  }
  const gitDir = path.join(resolved, '.git')
  if (!existsSync(gitDir)) {
    throw new Error(`Target is not a git repository: ${resolved}`)
  }
  return resolved
}

export function readHeadCommit(repoPath: string): string {
  try {
    const hash = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    if (!/^[0-9a-f]{40}$/.test(hash)) {
      throw new Error(`Unexpected commit hash: ${hash}`)
    }
    return hash
  } catch {
    throw new Error(`Could not read HEAD commit from ${repoPath}`)
  }
}

export function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
}

export function addSubmodule(courseDir: string, targetRepo: string, submodulePath: string): void {
  const absTarget = path.resolve(targetRepo)
  // Local paths use the file:// transport; Git 2.38+ blocks it unless explicitly allowed.
  execFileSync(
    'git',
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', absTarget, submodulePath],
    {
      cwd: courseDir,
      stdio: 'pipe',
    },
  )
}

export function checkoutSubmoduleCommit(
  courseDir: string,
  submodulePath: string,
  commit: string,
): void {
  const subDir = path.join(courseDir, submodulePath)
  execFileSync('git', ['checkout', commit], { cwd: subDir, stdio: 'pipe' })
}
