import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  return dir
}

export function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** Write files (relative path -> content) into a repo directory. */
export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** Create a repo with one committed file and return the commit SHA. */
export function initRepoWithCommit(dir: string, filename = 'README.md'): string {
  initRepo(dir)
  writeFiles(dir, { [filename]: '# test\n' })
  return commitAll(dir, 'initial')
}
