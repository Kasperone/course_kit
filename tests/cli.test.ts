import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { commitAll, initRepoWithCommit, writeFiles } from './helpers/git.js'
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

  it('runs the README flow init -> pin -> build (with a stand-in Slidev)', () => {
    const root = makeTempDir('cli-flow')
    const target = path.join(root, 'my-repo')
    const first = initRepoWithCommit(target)
    runCli(['init', target, '--out', './my-course', '--lang', 'en'], root)
    const ws = path.join(root, 'my-course')

    writeFiles(target, { 'NEW.md': 'x\n' })
    const second = commitAll(target, 'second')
    const pin = runCli(['pin', '-C', ws], root)
    expect(pin).toContain(`pinnedCommit: ${first} -> ${second}`)
    expect(runCli(['pin', first.slice(0, 10)], ws)).toContain(`${second} -> ${first}`)

    const log = installFakeSlidev(ws)
    const build = runCli(['build', '-C', ws], root)
    expect(build).toContain(
      `Built 01-placeholder/en -> ${path.join(ws, 'dist', '01-placeholder', 'en')}`,
    )
    expect(existsSync(path.join(ws, 'dist', 'index.html'))).toBe(true)
    expect(readFileSync(log, 'utf8')).toContain('"--router-mode","hash"')
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

describe('npm package contents', () => {
  it('ships the workspace templates, including the gitignore template', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(
      (f) => f.path,
    )
    for (const expected of [
      'templates/workspace/gitignore',
      'templates/workspace/LICENSE-CONTENT',
      'templates/workspace/.env.example',
      'templates/workspace/package.json',
      'templates/workspace/slides.md',
      'templates/workspace/scripts/check-deck.mjs',
      'templates/workspace/addons/narration/package.json',
      'templates/workspace/addons/narration/global-top.vue',
      'templates/workspace/addons/narration/setup/vite-plugins.ts',
    ]) {
      expect(files).toContain(expected)
    }
    expect(files.some((f) => /(^|\/)\.env$/.test(f))).toBe(false)
  })
})
