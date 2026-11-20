import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Full SHA-1 (40 hex) or SHA-256 (64 hex) object name. */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function gitOut(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitErrorDetail(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr
  const text = stderr ? String(stderr).trim() : ''
  return text || (err instanceof Error ? err.message : String(err))
}

/** Resolve a path inside a git working tree to the repository top level. */
export function resolveTargetRepo(repoPath: string): string {
  const resolved = path.resolve(repoPath)
  if (!existsSync(resolved)) {
    throw new Error(`Target path does not exist: ${resolved}`)
  }
  try {
    return path.resolve(gitOut(['-C', resolved, 'rev-parse', '--show-toplevel']))
  } catch (err) {
    throw new Error(`Target is not a git repository: ${resolved} (${gitErrorDetail(err)})`)
  }
}

export function readHeadCommit(repoPath: string): string {
  let hash: string
  try {
    hash = gitOut(['-C', repoPath, 'rev-parse', '--verify', 'HEAD^{commit}'])
  } catch (err) {
    throw new Error(`Could not read HEAD commit from ${repoPath}: ${gitErrorDetail(err)}`)
  }
  if (!FULL_SHA_RE.test(hash)) {
    throw new Error(`Unexpected commit hash from ${repoPath}: ${hash}`)
  }
  return hash
}

/**
 * The target's `origin` URL if it is a network remote, with any credentials stripped. Local-path
 * remotes return null so that no absolute filesystem path ends up in committed files.
 */
export function readShareableRemote(repoPath: string): string | null {
  let url: string
  try {
    url = gitOut(['-C', repoPath, 'remote', 'get-url', 'origin'])
  } catch {
    return null
  }
  if (/^(?:https?|ssh|git):\/\//i.test(url)) {
    try {
      const u = new URL(url)
      u.username = ''
      u.password = ''
      return u.toString()
    } catch {
      return null
    }
  }
  // scp-like syntax: git@github.com:owner/repo.git (the user part is a login name, not a secret)
  if (/^[\w.-]+@[\w.-]+:[^/\\]/.test(url)) return url
  return null
}

export function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' })
}

export function addSubmodule(
  courseDir: string,
  targetRepo: string,
  submodulePath: string,
  committedUrl: string,
): void {
  const absTarget = path.resolve(targetRepo)
  // Local paths use the file:// transport; Git 2.38+ blocks it for submodules unless explicitly
  // allowed. The override is scoped to this one command and to the user-chosen local path.
  execFileSync(
    'git',
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', absTarget, submodulePath],
    { cwd: courseDir, stdio: 'pipe' },
  )
  // `submodule add` records the absolute local path in .gitmodules. Replace it with a portable URL
  // (network remote or relative path) so no /home/<user>/... path is committed. The local
  // .git/config keeps the absolute URL, so this clone continues to work.
  execFileSync(
    'git',
    ['config', '-f', '.gitmodules', `submodule.${submodulePath}.url`, committedUrl],
    { cwd: courseDir, stdio: 'pipe' },
  )
  execFileSync('git', ['add', '--', '.gitmodules'], { cwd: courseDir, stdio: 'pipe' })
}

export function checkoutSubmoduleCommit(
  courseDir: string,
  submodulePath: string,
  commit: string,
): void {
  const subDir = path.join(courseDir, submodulePath)
  execFileSync('git', ['checkout', '-q', '--detach', commit], { cwd: subDir, stdio: 'pipe' })
  execFileSync('git', ['add', '--', submodulePath], { cwd: courseDir, stdio: 'pipe' })
}
