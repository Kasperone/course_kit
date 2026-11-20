import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  parseInitArgs,
  PLANTUML_DISABLED_SERVER,
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
  const { course } = await runInit({
    targetRepo: repoDir,
    outDir,
    languages: opts.languages ?? ['pl', 'en'],
    submodule: opts.submodule ?? false,
    cwd: root,
  })
  return { root, repoDir, pinned, outDir, course }
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
    expect(readFileSync(path.join(outDir, 'LICENSE-CONTENT'), 'utf8')).toContain('CC BY 4.0')
    expect(existsSync(path.join(outDir, 'lessons', 'pl', '01-placeholder', 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'lessons', 'en', '01-placeholder', 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'audio', 'ATTRIBUTION.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'audio', 'local', '.gitkeep'))).toBe(true)

    const onDisk = JSON.parse(readFileSync(path.join(outDir, 'course.json'), 'utf8'))
    expect(onDisk.pinnedCommit).toBe(pinned)
  })

  it('disables PlantUML via headmatter and ships a guard that blocks plantuml fences', async () => {
    const { outDir } = await initWorkspace()

    expect(existsSync(path.join(outDir, 'slidev.config.ts'))).toBe(false)
    expect(frontmatter(path.join(outDir, 'slides.md')).plantUmlServer).toBe(
      PLANTUML_DISABLED_SERVER,
    )
    for (const lang of ['pl', 'en']) {
      const fm = frontmatter(path.join(outDir, 'lessons', lang, '01-placeholder', 'slides.md'))
      expect(fm.plantUmlServer).toBe(PLANTUML_DISABLED_SERVER)
      expect(fm.lang).toBe(lang)
      expect(typeof fm.title).toBe('string')
    }

    const pkg = JSON.parse(readFileSync(path.join(outDir, 'package.json'), 'utf8'))
    expect(pkg.scripts.predev).toContain('check:diagrams')
    expect(pkg.scripts.prebuild).toContain('check:diagrams')
    expect(pkg.scripts.preexport).toContain('check:diagrams')

    const guard = path.join(outDir, 'scripts', 'check-no-plantuml.mjs')
    // Clean workspace passes.
    execFileSync(process.execPath, [guard, outDir], { stdio: 'pipe' })
    // A plantuml block anywhere in lessons fails.
    writeFileSync(
      path.join(outDir, 'lessons', 'en', '01-placeholder', 'slides.md'),
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
    ]) {
      expect(ignored(rel), rel).toBe(true)
    }
    for (const rel of ['.env.example', 'audio/local/.gitkeep', 'slides.md', 'course.json']) {
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
    const { root, pinned, outDir, course } = await initWorkspace({
      languages: ['en'],
      submodule: true,
    })
    expect(readFileSync(path.join(outDir, '.gitmodules'), 'utf8')).toContain('url = ../target')
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
