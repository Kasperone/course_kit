import { execFileSync } from 'node:child_process'

export function listTrackedPathsAtCommit(repo: string, commit: string): string[] {
  const out = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', commit], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

export function readBlobAtCommit(repo: string, commit: string, filePath: string): Buffer | null {
  try {
    const data = execFileSync('git', ['-C', repo, 'show', `${commit}:${filePath}`], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as Buffer
    return data
  } catch {
    return null
  }
}

export function readTextAtCommit(repo: string, commit: string, filePath: string): string | null {
  const buf = readBlobAtCommit(repo, commit, filePath)
  if (buf === null) return null
  if (buf.includes(0)) return null
  return buf.toString('utf8')
}

export function blobSizeAtCommit(repo: string, commit: string, filePath: string): number {
  try {
    const size = execFileSync('git', ['-C', repo, 'cat-file', '-s', `${commit}:${filePath}`], {
      encoding: 'utf8',
    }).trim()
    const n = Number(size)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function logTouchingPaths(
  repo: string,
  commit: string,
  paths: string[],
  maxEntries: number,
): string[] {
  if (paths.length === 0) return []
  const args = [
    '-C',
    repo,
    'log',
    '-n',
    String(maxEntries),
    '--format=%h %an %ad %s',
    '--date=short',
    commit,
    '--',
    ...paths,
  ]
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function commandOnPath(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
