import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  parseInitArgs,
  LOCAL_CONFIG_FILE,
  PLANTUML_DISABLED_SERVER,
  portableRelativePath,
  resolveCourseTargetRepo,
  runInit,
  SUBMODULE_PATH,
} from '../src/commands/init.js'
import { git, initRepoWithCommit } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

/** Every file in the workspace (skipping .git internals) whose content contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === '.git') continue
      const abs = path.join(d, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (readFileSync(abs, 'utf8').includes(needle)) hits.push(path.relative(dir, abs))
    }
  }
  walk(dir)
  return hits
}

function frontmatter(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error(`No frontmatter in ${file}`)
  return parseYaml(m[1]!) as Record<string, unknown>
}

async function initWorkspace(opts: { languages?: string[]; submodule?: boolean } = {}) {
  const root = makeTempDir('init')
  const repoDir = path.join(root, 'target')
  const pinned = initRepoWithCommit(repoDir, opts.submodule ? 'app.txt' : 'README.md')
  const outDir = path.join(root, 'out-course')
  const { course, warnings } = await runInit({
    targetRepo: repoDir,
    outDir,
    languages: opts.languages ?? ['pl', 'en'],
    submodule: opts.submodule ?? false,
    cwd: root,
  })
  return { root, repoDir, pinned, outDir, course, warnings }
}

describe('course init', () => {
  it('creates workspace files and pins HEAD commit', async () => {
    const { pinned, outDir, course } = await initWorkspace()

    expect(course.pinnedCommit).toBe(pinned)
    expect(course.referenceMode).toBe('pinned-path')
    expect(course.languages).toEqual(['pl', 'en'])

    expect(existsSync(path.join(outDir, 'course.json'))).toBe(true)
    expect(existsSync(path.join(outDir, 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, '.env.example'))).toBe(true)
    const notice = readFileSync(path.join(outDir, 'LICENSE-CONTENT'), 'utf8')
    expect(notice).toContain('CC BY 4.0')
    // The workspace's lessons belong to the course author, not to course_kit's author.
    expect(notice).not.toMatch(/Copyright.*Kasperone/)
    expect(notice).toMatch(/^Copyright \(c\) <year> <course author>$/m)
    expect(notice).toContain('https://github.com/Kasperone/course_kit/blob/main/LICENSE')
    expect(existsSync(path.join(outDir, 'LICENSE'))).toBe(false)
    expect(existsSync(path.join(outDir, 'lessons', '01-placeholder', 'lesson.json'))).toBe(true)
    expect(existsSync(path.join(outDir, 'lessons', '01-placeholder', 'pl', 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'lessons', '01-placeholder', 'en', 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'audio', 'ATTRIBUTION.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'audio', 'local', '.gitkeep'))).toBe(true)

    const onDisk = JSON.parse(readFileSync(path.join(outDir, 'course.json'), 'utf8'))
    expect(onDisk.pinnedCommit).toBe(pinned)
  })

  it('disables PlantUML via headmatter and ships a guard that blocks plantuml fences', async () => {
    const { outDir } = await initWorkspace()

    expect(existsSync(path.join(outDir, 'slidev.config.ts'))).toBe(false)
    const decks = [
      path.join(outDir, 'slides.md'),
      ...['pl', 'en'].map((lang) =>
        path.join(outDir, 'lessons', '01-placeholder', lang, 'slides.md'),
      ),
    ]
    for (const deck of decks) {
      const fm = frontmatter(deck)
      expect(fm.plantUmlServer, deck).toBe(PLANTUML_DISABLED_SERVER)
      // Slidev defaults: Google Fonts and a cdn.jsdelivr.net favicon. Both must be overridden.
      expect(fm.fonts, deck).toMatchObject({ provider: 'none', sans: 'system-ui' })
      expect(fm.favicon, deck).toBe('data:,')
      expect(fm.browserExporter, deck).toBe(false)
      expect(fm.download, deck).toBe(false)
      expect(fm.mcp, deck).toBe(false)
      expect(readFileSync(deck, 'utf8'), deck).not.toMatch(/https?:\/\/(?!creativecommons)/)
    }
    for (const lang of ['pl', 'en']) {
      const fm = frontmatter(path.join(outDir, 'lessons', '01-placeholder', lang, 'slides.md'))
      expect(fm.lang).toBe(lang)
      expect(typeof fm.title).toBe('string')
    }

    const pkg = JSON.parse(readFileSync(path.join(outDir, 'package.json'), 'utf8'))
    expect(pkg.scripts.predev).toContain('check:deck')
    expect(pkg.scripts.prebuild).toContain('check:deck')
    // Static build and live preview only: no PDF/PNG export and no Playwright dependency.
    expect(pkg.scripts.export).toBeUndefined()
    expect(pkg.scripts.preexport).toBeUndefined()
    expect(JSON.stringify(pkg)).not.toMatch(/playwright/i)

    const guard = path.join(outDir, 'scripts', 'check-deck.mjs')
    // Clean workspace passes.
    execFileSync(process.execPath, [guard, outDir], { stdio: 'pipe' })
    // A plantuml block anywhere in lessons fails.
    writeFileSync(
      path.join(outDir, 'lessons', '01-placeholder', 'en', 'slides.md'),
      '# x\n\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n',
      'utf8',
    )
    let stderr = ''
    try {
      execFileSync(process.execPath, [guard, outDir], { stdio: 'pipe', encoding: 'utf8' })
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr)
    }
    expect(stderr).toContain('PlantUML blocks are not allowed')
    expect(stderr).toContain('lessons')
  })

  it('ships a guard that blocks web fonts and an online or exporting root deck', async () => {
    const { outDir } = await initWorkspace()
    const guard = path.join(outDir, 'scripts', 'check-deck.mjs')
    const run = () => {
      try {
        execFileSync(process.execPath, [guard, outDir], { stdio: 'pipe', encoding: 'utf8' })
        return ''
      } catch (err) {
        return String((err as { stderr?: string }).stderr)
      }
    }
    expect(run()).toBe('')
    const css = path.join(outDir, 'styles.css')
    writeFileSync(css, "@import url('https://fonts.googleapis.com/css2?family=Inter');\n")
    expect(run()).toContain('Web fonts from a CDN are not allowed')
    rmSync(css)

    const rootDeck = path.join(outDir, 'slides.md')
    const original = readFileSync(rootDeck, 'utf8')
    writeFileSync(rootDeck, original.replace("provider: 'none'", "provider: 'google'"))
    expect(run()).toContain('fonts.provider must be "none"')
    writeFileSync(rootDeck, original.replace('browserExporter: false', 'browserExporter: dev'))
    expect(run()).toContain('browserExporter must be false')
    writeFileSync(rootDeck, original.replace('download: false', 'download: true'))
    expect(run()).toContain('download must not be enabled')
    writeFileSync(rootDeck, original.replace("favicon: 'data:,'\n", ''))
    expect(run()).toContain('favicon must be a data: URL')
    writeFileSync(rootDeck, original.replace('mcp: false', 'mcp: true'))
    expect(run()).toContain('mcp must be false')
  })

  it('the deck guard never follows symlinks (loops, links outside the workspace)', async () => {
    const { root, outDir } = await initWorkspace()
    const guard = path.join(outDir, 'scripts', 'check-deck.mjs')
    const outside = path.join(root, 'outside-docs')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'arch.md'), '```plantuml\nA -> B\n```\n', 'utf8')
    symlinkSync('..', path.join(outDir, 'lessons', '01-placeholder', 'en', 'loop'))
    symlinkSync(outside, path.join(outDir, 'lessons', 'docs'))
    symlinkSync(path.join(outside, 'arch.md'), path.join(outDir, 'lessons', 'arch.md'))
    execFileSync(process.execPath, [guard, outDir], { stdio: 'pipe' })
  })

  it('gitignores .env, .env.* and local audio but keeps .env.example', async () => {
    const { outDir } = await initWorkspace()
    execFileSync('git', ['init', '-q'], { cwd: outDir })
    const ignored = (rel: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', rel], { cwd: outDir, stdio: 'pipe' })
        return true
      } catch {
        return false
      }
    }
    for (const rel of [
      '.env',
      '.env.local',
      '.env.production',
      'keys/server.pem',
      'audio/local/clip.mp3',
      'lessons/01-placeholder/context-pack.md',
      'lessons/01-placeholder/context-pack.json',
    ]) {
      expect(ignored(rel), rel).toBe(true)
    }
    for (const rel of [
      '.env.example',
      'audio/local/.gitkeep',
      'slides.md',
      'course.json',
      'lessons/01-placeholder/lesson.json',
      'lessons/01-placeholder/en/slides.md',
    ]) {
      expect(ignored(rel), rel).toBe(false)
    }
    expect(existsSync(path.join(outDir, 'gitignore'))).toBe(false)
  })

  it('stores a workspace-relative target path, never an absolute one', async () => {
    const { root, repoDir, outDir, course } = await initWorkspace()
    expect(course.targetRepo).toBe('../target')
    expect(course.targetRemote).toBeNull()
    expect(realpathSync(resolveCourseTargetRepo(outDir, course.targetRepo))).toBe(
      realpathSync(repoDir),
    )
    expect(filesContaining(outDir, root)).toEqual([])
  })

  it.each([
    ['/home/u/courses/ws', '/home/u/projects/repo', '../../projects/repo'],
    ['/home/u/repo/course', '/home/u/repo', '..'],
    ['/tmp/a/ws', '/tmp/b/repo', '../../b/repo'],
    ['/tmp/ws', '/home/u/repo', null],
    ['/opt/ws', '/srv/repo', null],
    ['/home/other/ws', '/home/u/repo', null],
  ])('portableRelativePath(%s -> %s) = %s', (from, to, expected) => {
    expect(portableRelativePath(from, to, '/home/u')).toBe(expected)
  })

  it('treats a sibling named like "..cache" as inside the home directory', () => {
    expect(portableRelativePath('/data/ws', '/data/u/..cache/repo', '/data/u')).toBeNull()
    expect(portableRelativePath('/data/u/ws', '/data/u/..cache/repo', '/data/u')).toBe(
      '../..cache/repo',
    )
  })

  it('computes the relative path from the physical workspace dir when reached via a symlink', async () => {
    const root = realpathSync(makeTempDir('init-linked-out'))
    const repoDir = path.join(root, 'x', 'target')
    initRepoWithCommit(repoDir)
    mkdirSync(path.join(root, 'x', 'real'))
    mkdirSync(path.join(root, 'x', 'a', 'b'), { recursive: true })
    symlinkSync(path.join(root, 'x', 'real'), path.join(root, 'x', 'a', 'b', 'link'))
    const outDir = path.join(root, 'x', 'a', 'b', 'link', 'ws')

    const { course } = await runInit({
      targetRepo: repoDir,
      outDir,
      languages: ['en'],
      submodule: false,
    })

    // Relative to x/real/ws (where the files are), not to the lexical x/a/b/link/ws.
    expect(course.targetRepo).toBe('../../target')
    for (const spelling of [outDir, path.join(root, 'x', 'real', 'ws')]) {
      const resolved = resolveCourseTargetRepo(spelling, course.targetRepo)
      expect(resolved).toBe(repoDir)
      expect(git(resolved, ['rev-parse', '--show-toplevel']).trim()).toBe(repoDir)
    }
  })

  it('never encodes the home directory when $HOME is a symlink to the real home', async () => {
    const root = realpathSync(makeTempDir('init-linked-home'))
    const realHome = path.join(root, 'data', 'users', 'alice')
    const repoDir = path.join(realHome, 'repo')
    initRepoWithCommit(repoDir)
    symlinkSync(realHome, path.join(root, 'home-alice'))
    const previousHome = process.env.HOME
    process.env.HOME = path.join(root, 'home-alice')
    try {
      const outDir = path.join(root, 'data', 'tmp', 'ws')
      const { course, warnings } = await runInit({
        targetRepo: path.join(root, 'home-alice', 'repo'),
        outDir,
        languages: ['en'],
        submodule: false,
      })
      // Without the realpath check this was "../../users/alice/repo".
      expect(course.targetRepo).toBeNull()
      expect(readFileSync(path.join(outDir, 'course.json'), 'utf8')).not.toContain('alice')
      expect(resolveCourseTargetRepo(outDir, course.targetRepo)).toBe(repoDir)
      expect(warnings.join('\n')).toContain(LOCAL_CONFIG_FILE)
    } finally {
      process.env.HOME = previousHome
    }
  })

  it('keeps the path in a gitignored course.local.json when no portable path exists', async () => {
    const root = makeTempDir('init-local')
    const fakeHome = path.join(root, 'home-u')
    const repoDir = path.join(fakeHome, 'projects', 'target')
    initRepoWithCommit(repoDir)
    const previousHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const outDir = path.join(root, 'elsewhere', 'ws')
      const { course, warnings } = await runInit({
        targetRepo: repoDir,
        outDir,
        languages: ['en'],
        submodule: false,
      })
      expect(course.targetRepo).toBeNull()
      expect(warnings).toEqual([expect.stringContaining('COURSE_TARGET_REPO')])
      const local = JSON.parse(readFileSync(path.join(outDir, LOCAL_CONFIG_FILE), 'utf8'))
      expect(local.targetRepo).toBe(repoDir)
      expect(resolveCourseTargetRepo(outDir, course.targetRepo)).toBe(repoDir)
      expect(filesContaining(outDir, fakeHome)).toEqual([LOCAL_CONFIG_FILE])
      git(outDir, ['init', '-q'])
      expect(git(outDir, ['check-ignore', LOCAL_CONFIG_FILE]).trim()).toBe(LOCAL_CONFIG_FILE)
    } finally {
      process.env.HOME = previousHome
    }
  })

  it('records a credential-free network origin and ignores local-path origins', async () => {
    const root = makeTempDir('init-remote')
    const repoDir = path.join(root, 'target')
    initRepoWithCommit(repoDir)
    git(repoDir, ['remote', 'add', 'origin', 'https://user:s3cret@github.com/acme/app.git'])
    const { course } = await runInit({
      targetRepo: repoDir,
      outDir: path.join(root, 'ws'),
      languages: ['en'],
      submodule: false,
    })
    expect(course.targetRemote).toBe('https://github.com/acme/app.git')

    const shared = async (url: string, out: string) => {
      git(repoDir, ['remote', 'set-url', 'origin', url])
      const r = await runInit({
        targetRepo: repoDir,
        outDir: path.join(root, out),
        languages: ['en'],
        submodule: false,
      })
      return r.course.targetRemote
    }
    // ssh:// keeps its login (without it ssh uses the local user name); a password never stays.
    expect(await shared('ssh://git@github.com/acme/app.git', 'ws-ssh')).toBe(
      'ssh://git@github.com/acme/app.git',
    )
    expect(await shared('ssh://git:pw@host.example/acme/app.git', 'ws-ssh-pw')).toBe(
      'ssh://git@host.example/acme/app.git',
    )
    expect(await shared('git@github.com:acme/app.git', 'ws-scp')).toBe(
      'git@github.com:acme/app.git',
    )
    // Query-string and fragment tokens are dropped (GitLab-style ?private_token=).
    expect(
      await shared(
        'https://oauth2@gitlab.example/acme/app.git?private_token=glpat-XYZ#t=1',
        'ws-q',
      ),
    ).toBe('https://gitlab.example/acme/app.git')
    expect(filesContaining(path.join(root, 'ws-q'), 'glpat')).toEqual([])

    git(repoDir, ['remote', 'set-url', 'origin', path.join(root, 'elsewhere')])
    const second = await runInit({
      targetRepo: repoDir,
      outDir: path.join(root, 'ws2'),
      languages: ['en'],
      submodule: false,
    })
    expect(second.course.targetRemote).toBeNull()
  })

  it('accepts a subdirectory of the target and pins its repository root', async () => {
    const root = makeTempDir('init-subdir')
    const repoDir = path.join(root, 'target')
    const pinned = initRepoWithCommit(repoDir)
    const sub = path.join(repoDir, 'nested')
    mkdirSync(sub)
    const { course } = await runInit({
      targetRepo: sub,
      outDir: path.join(root, 'ws'),
      languages: ['en'],
      submodule: false,
    })
    expect(course.pinnedCommit).toBe(pinned)
    expect(course.targetRepo).toBe('../target')
  })

  it('adds optional git submodule at pinned commit', async () => {
    const { root, pinned, outDir, course, warnings } = await initWorkspace({
      languages: ['en'],
      submodule: true,
    })
    expect(readFileSync(path.join(outDir, '.gitmodules'), 'utf8')).toContain('url = ../target')
    expect(warnings).toEqual([])
    expect(filesContaining(outDir, root)).toEqual([])
    const staged = git(outDir, ['ls-files', '-s', SUBMODULE_PATH])
    expect(staged).toContain(pinned)

    expect(course.referenceMode).toBe('submodule')
    expect(course.submodulePath).toBe(SUBMODULE_PATH)
    expect(existsSync(path.join(outDir, SUBMODULE_PATH, 'app.txt'))).toBe(true)
    const subHead = execFileSync(
      'git',
      ['-C', path.join(outDir, SUBMODULE_PATH), 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim()
    expect(subHead).toBe(pinned)
  })

  it('warns when --submodule records a network URL for a commit that was never pushed', async () => {
    const root = makeTempDir('init-unpushed')
    const repoDir = path.join(root, 'target')
    const pinned = initRepoWithCommit(repoDir)
    git(repoDir, ['remote', 'add', 'origin', 'https://git.example/acme/app.git'])
    const init = (out: string) =>
      runInit({
        targetRepo: repoDir,
        outDir: path.join(root, out),
        languages: ['en'],
        submodule: true,
      })

    const unpushed = await init('ws1')
    expect(readFileSync(path.join(root, 'ws1', '.gitmodules'), 'utf8')).toContain(
      'url = https://git.example/acme/app.git',
    )
    expect(unpushed.warnings).toEqual([
      expect.stringContaining(`${pinned} is on no remote-tracking branch`),
    ])

    // Once a remote-tracking branch contains it (as after a push), there is nothing to warn about.
    git(repoDir, ['update-ref', 'refs/remotes/origin/main', pinned])
    expect((await init('ws2')).warnings).toEqual([])
  })
})

describe('course init input validation', () => {
  it.each([['en,../../../escaped-lang'], ['en/x'], ['EN\ntitle: injected'], ['e'], [',']])(
    'rejects --lang %j',
    (lang) => {
      expect(() => parseInitArgs({ target: '/tmp/x', lang })).toThrow(/language/)
    },
  )

  it('accepts and normalises valid language codes', () => {
    expect(parseInitArgs({ target: '/tmp/x', lang: ' PL, en ,pt-BR,en' }).languages).toEqual([
      'pl',
      'en',
      'pt-br',
    ])
  })

  it('runInit rejects traversal in languages and writes nothing outside the workspace', async () => {
    const root = makeTempDir('init-lang')
    const repoDir = path.join(root, 'target')
    initRepoWithCommit(repoDir)
    await expect(
      runInit({
        targetRepo: repoDir,
        outDir: path.join(root, 'ws'),
        languages: ['en', '../../escaped'],
        submodule: false,
      }),
    ).rejects.toThrow(/Invalid language code/)
    expect(existsSync(path.join(root, 'escaped'))).toBe(false)
    expect(existsSync(path.join(root, 'ws'))).toBe(false)
  })
})
