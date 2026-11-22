import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { commitAll, initRepoWithCommit, writeFiles } from './helpers/git.js'
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

  it('runs `lesson new` and `context --out x.md --json` from a workspace', () => {
    const root = makeTempDir('cli-context')
    const target = path.join(root, 'repo')
    initRepoWithCommit(target)
    runCli(['init', target, '--out', './ws', '--lang', 'en'], root)
    const ws = path.join(root, 'ws')

    expect(runCli(['lesson', 'new', '02-invoices'], ws)).toContain('Lesson created at')
    expect(existsSync(path.join(ws, 'lessons', '02-invoices', 'lesson.json'))).toBe(true)
    expect(existsSync(path.join(ws, 'lessons', '02-invoices', 'en', 'slides.md'))).toBe(true)

    // --out in a directory that does not exist yet, plus the .json next to it.
    const out = runCli(['context', '02-invoices', '--out', 'notes/pack.md', '--json'], ws)
    expect(out).toContain('Wrote context pack for 02-invoices')
    expect(readFileSync(path.join(ws, 'notes', 'pack.md'), 'utf8')).toContain('# Context pack')
    const meta = JSON.parse(readFileSync(path.join(ws, 'notes', 'pack.json'), 'utf8'))
    expect(meta.lessonId).toBe('02-invoices')
    // Without --out the pack lands next to the lesson.
    runCli(['context', '02-invoices'], ws)
    expect(existsSync(path.join(ws, 'lessons', '02-invoices', 'context-pack.md'))).toBe(true)

    const bad = spawnSync(process.execPath, [distCli, 'lesson', 'new', '../x'], {
      cwd: ws,
      encoding: 'utf8',
    })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('course lesson new failed')
  })

  it('never prints raw terminal escape sequences from the target repo', () => {
    const root = makeTempDir('cli-escapes')
    const target = path.join(root, 'repo')
    const evilFile = 'src/evil\x1b]0;PWNED-TITLE\x07\x1b[31mRED.java'
    const evilDir = 'dir\x1b[2J'
    initRepoWithCommit(target)
    writeFiles(target, {
      [evilFile]: 'class A { String password = "hunter2hunter2"; }\n',
      [`${evilDir}/.env`]: 'KEY=value\n',
      'src/ok.java': 'class B {}\n',
    })
    commitAll(target, 'evil names')
    runCli(['init', target, '--out', './ws', '--lang', 'en'], root)
    const ws = path.join(root, 'ws')
    const lessonJson = path.join(ws, 'lessons', '01-placeholder', 'lesson.json')
    const lesson = JSON.parse(readFileSync(lessonJson, 'utf8'))
    writeFileSync(
      lessonJson,
      JSON.stringify({
        ...lesson,
        files: ['missing\x1b[2Jfile.txt'],
        globs: ['src/**', `${evilDir}/**`],
      }),
    )

    const run = spawnSync(process.execPath, [distCli, 'context', '01-placeholder', '--json'], {
      cwd: ws,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    // All three warnings fire (redaction, sensitive file, missing file) ...
    expect(run.stderr).toMatch(/Redacted 1 secret-looking value/)
    expect(run.stderr).toMatch(/sensitive file\(s\) were not embedded/)
    expect(run.stderr).toMatch(/files not found/)
    // ... and none of them lets the target (or lesson.json) write control sequences.
    // eslint-disable-next-line no-control-regex -- asserting that none are present
    expect(run.stderr + run.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    expect(run.stderr).toContain('evil\\x1b]0;PWNED-TITLE\\x07\\x1b[31mRED.java')
    // The JSON metadata keeps the raw names (JSON.stringify escapes them itself).
    const meta = JSON.parse(
      readFileSync(path.join(ws, 'lessons', '01-placeholder', 'context-pack.json'), 'utf8'),
    )
    expect(meta.redactions[0].path).toBe(evilFile)

    // Error messages quoting such text are sanitised too.
    writeFileSync(lessonJson, '{ "id": "01-placeholder", "files": ["a\x1b[31m"], ')
    const failed = spawnSync(process.execPath, [distCli, 'context', '01-placeholder'], {
      cwd: ws,
      encoding: 'utf8',
    })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('course context failed')
    // eslint-disable-next-line no-control-regex -- asserting that none are present
    expect(failed.stderr).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  })

  it('rejects a --port with trailing garbage instead of truncating it', () => {
    const root = makeTempDir('cli-port')
    const target = path.join(root, 'repo')
    initRepoWithCommit(target)
    runCli(['init', target, '--out', './ws', '--lang', 'en'], root)
    const ws = path.join(root, 'ws')
    const log = installFakeSlidev(ws)
    for (const port of ['3000abc', '30 00', '', '0x1f90', '1e3', '1e3x', '-1']) {
      const run = spawnSync(process.execPath, [distCli, 'dev', '01-placeholder', '--port', port], {
        cwd: ws,
        encoding: 'utf8',
      })
      expect(run.status, `--port ${JSON.stringify(port)}`).toBe(1)
      expect(run.stderr).toContain('Invalid port')
    }
    expect(existsSync(log)).toBe(false) // Slidev never started
    expect(runCli(['dev', '01-placeholder', '--port', '3031'], ws)).toBe('')
    expect(readFileSync(log, 'utf8')).toContain('"--port","3031"')
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
