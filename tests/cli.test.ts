import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { initRepoWithCommit } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distCli = path.join(repoRoot, 'dist', 'cli.js')

function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [distCli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

describe('built CLI (dist/cli.js)', () => {
  beforeAll(() => {
    // Build exactly like `npm run build` so the bundled path resolution is exercised.
    execFileSync(process.execPath, [path.join(repoRoot, 'node_modules/tsup/dist/cli-default.js')], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
  })

  it('prints help', () => {
    const out = runCli(['--help'], repoRoot)
    expect(out).toContain('init')
  })

  it('runs the README quickstart `course init` from an unrelated cwd', () => {
    const root = makeTempDir('cli')
    const target = path.join(root, 'my-repo')
    const pinned = initRepoWithCommit(target)

    const out = runCli(['init', target, '--out', './my-course', '--lang', 'pl,en'], root)
    expect(out).toContain('Course workspace created')

    const ws = path.join(root, 'my-course')
    const course = JSON.parse(readFileSync(path.join(ws, 'course.json'), 'utf8'))
    expect(course.pinnedCommit).toBe(pinned)
    expect(existsSync(path.join(ws, 'slides.md'))).toBe(true)
    expect(existsSync(path.join(ws, '.gitignore'))).toBe(true)
    expect(existsSync(path.join(ws, 'package.json'))).toBe(true)
  })

  it('exits non-zero with a clear message on bad input', () => {
    const root = makeTempDir('cli-bad')
    let failed = false
    try {
      runCli(['init', path.join(root, 'missing')], root)
    } catch (err) {
      failed = true
      expect(String((err as { stderr?: string }).stderr)).toContain('course init failed')
    }
    expect(failed).toBe(true)
  })
})
