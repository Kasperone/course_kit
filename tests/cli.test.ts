import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { initRepoWithCommit } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distCli = path.join(repoRoot, 'dist', 'cli.js')

function runCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [distCli, ...args], {
    cwd,
    env,
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

  it('prints each option default once in `init --help`', () => {
    const help = runCli(['init', '--help'], repoRoot)
    expect(help).toContain('--lang <codes>')
    expect(help).toContain('./<repo>-course')
    for (const line of help.split('\n')) {
      expect(line.match(/\(default:/g)?.length ?? 0, line).toBeLessThanOrEqual(1)
    }
    expect(help).toContain('(default: "pl,en")')
    expect(help).not.toContain('(default: pl,en)')
    expect(help).not.toMatch(/--submodule.*\(default: false\)/s)
  })

  it('refuses git older than 2.38, which ignores safe.bareRepository', () => {
    const root = makeTempDir('cli-old-git')
    const target = path.join(root, 'my-repo')
    initRepoWithCommit(target)
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.34.1"; exit 0; fi\n' +
        'PATH="${PATH#*:}" exec git "$@"\n',
      { mode: 0o755 },
    )
    let stderr = ''
    try {
      runCli(['init', target, '--out', './ws'], root, {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      })
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr)
    }
    expect(stderr).toContain('course init failed')
    expect(stderr).toContain('needs git >= 2.38 (found git version 2.34.1)')
    expect(existsSync(path.join(root, 'ws'))).toBe(false)
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
      'templates/workspace/scripts/check-no-plantuml.mjs',
    ]) {
      expect(files).toContain(expected)
    }
    expect(files.some((f) => /(^|\/)\.env$/.test(f))).toBe(false)
  })
})
