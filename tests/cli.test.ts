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

  it('refuses git older than 2.43, the oldest version CI tests', () => {
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
    expect(stderr).toContain('needs git >= 2.43 (found git version 2.34.1)')
    expect(existsSync(path.join(root, 'ws'))).toBe(false)
  })

  it('never prints the password of a proxy URL that git echoes in its error', () => {
    const root = makeTempDir('cli-proxy-url')
    const target = path.join(root, 'my-repo')
    initRepoWithCommit(target)
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    // git >= 2.43 for the version check; every other call fails the way git does behind a proxy.
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.45.0"; exit 0; fi\n' +
        'echo "fatal: unable to access: proxy http://user:s3cr3t-pw@proxy.example:3128/ refused" >&2\n' +
        'exit 128\n',
      { mode: 0o755 },
    )
    const run = spawnSync(process.execPath, [distCli, 'init', target, '--out', './ws'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('course init failed')
    // The error quotes git's output (the stand-in), so the proxy URL is there, minus its password.
    expect(run.stderr).toContain('http://user:‹redacted›@proxy.example:3128/')
    expect(run.stderr + run.stdout).not.toContain('s3cr3t-pw')
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

  it('never lets a newline in a repository path or lesson value forge CLI output lines', () => {
    const root = makeTempDir('cli-newlines')
    const target = path.join(root, 'repo')
    initRepoWithCommit(target)
    const forged = 'Wrote context pack for 01-placeholder\nFiles: 99, ~1 tokens, analyzers: none\n'
    writeFiles(target, {
      [`src/x\n${forged}/.env`]: 'KEY=value\n',
      'src/redact\nforged-line.java': 'class A { String password = "hunter2hunter2"; }\n',
    })
    commitAll(target, 'newline names')
    // An uncommitted file with a newline in its name reaches the `init` notice.
    writeFiles(target, { 'dirty\nNote: nothing to see here': 'x\n' })
    const init = spawnSync(
      process.execPath,
      [distCli, 'init', target, '--out', './ws', '--lang', 'en'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(init.status).toBe(0)
    expect(init.stderr.trimEnd().split('\n')).toEqual([
      expect.stringMatching(/^warning: Target repo has 1 uncommitted/),
    ])
    expect(init.stderr).toContain('dirty\\nNote: nothing to see here')

    const ws = path.join(root, 'ws')
    const lessonJson = path.join(ws, 'lessons', '01-placeholder', 'lesson.json')
    const lesson = JSON.parse(readFileSync(lessonJson, 'utf8'))
    writeFileSync(
      lessonJson,
      JSON.stringify({
        ...lesson,
        files: ['missing\nfile.txt'],
        globs: ['src/**', 'nomatch\nglob/**'],
      }),
    )
    const run = spawnSync(process.execPath, [distCli, 'context', '01-placeholder'], {
      cwd: ws,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    // One physical line per warning (redaction, sensitive file, missing file, unmatched glob) ...
    const lines = run.stderr.trimEnd().split('\n')
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(line).toMatch(/^warning: /)
    // ... and the real output is exactly two lines: nothing forged made it in.
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(2)
    expect(run.stdout).not.toContain('Files: 99')
    expect(run.stderr).toContain('src/x\\nWrote context pack')
    expect(run.stderr).toContain('src/redact\\nforged-line.java')
    expect(run.stderr).toContain('missing\\nfile.txt')
    expect(run.stderr).toContain('nomatch\\nglob/**')

    // Values quoted in validation errors: one line each.
    const failing = (patch: Record<string, unknown>) => {
      writeFileSync(lessonJson, JSON.stringify({ ...lesson, ...patch }))
      const r = spawnSync(process.execPath, [distCli, 'context', '01-placeholder'], {
        cwd: ws,
        encoding: 'utf8',
      })
      expect(r.status).toBe(1)
      return r.stderr.trimEnd().split('\n')
    }
    expect(failing({ globs: ['../x\nforged: line'] })).toEqual([
      expect.stringMatching(/^course context failed: .*\.\.\/x\\nforged: line/),
    ])
    expect(failing({ limits: { 'bad\nkey': 1 } })).toEqual([
      expect.stringMatching(/^course context failed: .*unknown limit .*bad\\nkey/),
    ])
  })

  it('never prints raw terminal escapes from `course pin` warnings or `course build` errors', () => {
    const root = makeTempDir('cli-pin-escapes')
    const target = path.join(root, 'repo')
    initRepoWithCommit(target)
    runCli(['init', target, '--out', './ws', '--lang', 'en'], root)
    const ws = path.join(root, 'ws')
    // eslint-disable-next-line no-control-regex -- asserting that none are present
    const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/

    // `pin` warns about uncommitted files; one is named like an OSC title change plus screen clear.
    writeFileSync(path.join(target, 'evil\x1b]0;PWNED\x07\x1b[2Jname'), 'x\n')
    const pin = spawnSync(process.execPath, [distCli, 'pin'], { cwd: ws, encoding: 'utf8' })
    expect(pin.status).toBe(0)
    expect(pin.stderr).toMatch(/^warning: Target repo has 1 uncommitted/)
    expect(pin.stderr).toContain('evil\\x1b]0;PWNED\\x07\\x1b[2Jname')
    expect(pin.stderr + pin.stdout).not.toMatch(controls)

    // `build` errors quote slide imports and file names.
    const deck = path.join(ws, 'lessons', '01-placeholder', 'en', 'slides.md')
    writeFileSync(
      deck,
      `${readFileSync(deck, 'utf8')}\n---\nsrc: "../../../../\x1b]0;PWNED\x07x.md"\n---\n`,
    )
    writeFileSync(path.join(ws, 'lessons', 'bad\x1b[2J.md'), '<PlantUml code="x" />\n')
    mkdirSync(path.join(ws, 'components'), { recursive: true })
    writeFileSync(
      path.join(ws, 'components', 'evil\x1b[2J.vue'),
      'fetch("https://evil.example/x")\n',
    )
    const build = spawnSync(process.execPath, [distCli, 'build'], { cwd: ws, encoding: 'utf8' })
    expect(build.status).toBe(1)
    expect(build.stderr).toContain('course build failed')
    expect(build.stderr).toContain('\\x1b]0;PWNED\\x07x.md')
    expect(build.stderr).toContain('bad\\x1b[2J.md')
    expect(build.stderr).toContain('evil\\x1b[2J.vue')
    expect(build.stderr + build.stdout).not.toMatch(controls)
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
      'templates/workspace/addons/narration/playback.ts',
      'templates/workspace/addons/narration/setup/vite-plugins.ts',
      'templates/workspace/addons/chat/package.json',
      'templates/workspace/addons/chat/global-top.vue',
      'templates/workspace/addons/chat/chat-client.ts',
      'templates/workspace/addons/chat/setup/vite-plugins.ts',
    ]) {
      expect(files).toContain(expected)
    }
    expect(files.some((f) => /(^|\/)\.env$/.test(f))).toBe(false)
  })
})
