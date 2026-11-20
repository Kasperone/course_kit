import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { runInit, SUBMODULE_PATH } from '../src/commands/init.js'

function initBareRepo(dir: string, filename = 'README.md'): string {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'course-kit@test.local'], {
    cwd: dir,
    stdio: 'pipe',
  })
  execFileSync('git', ['config', 'user.name', 'course-kit'], { cwd: dir, stdio: 'pipe' })
  writeFileSync(path.join(dir, filename), '# test\n', 'utf8')
  execFileSync('git', ['add', filename], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' })
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

const tempDirs: string[] = []

afterEach(() => {
  tempDirs.length = 0
})

describe('course init', () => {
  it('creates workspace files and pins HEAD commit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'course-kit-repo-'))
    tempDirs.push(root)
    const repoDir = path.join(root, 'target')
    await mkdir(repoDir, { recursive: true })
    const pinned = initBareRepo(repoDir)

    const outDir = path.join(root, 'out-course')
    const { course } = await runInit({
      targetRepo: repoDir,
      outDir,
      languages: ['pl', 'en'],
      submodule: false,
      cwd: root,
    })

    expect(course.pinnedCommit).toBe(pinned)
    expect(course.referenceMode).toBe('pinned-path')
    expect(course.languages).toEqual(['pl', 'en'])

    expect(existsSync(path.join(outDir, 'course.json'))).toBe(true)
    expect(existsSync(path.join(outDir, 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'slidev.config.ts'))).toBe(true)
    expect(existsSync(path.join(outDir, '.env.example'))).toBe(true)
    expect(existsSync(path.join(outDir, 'lessons', 'pl', '01-placeholder', 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'lessons', 'en', '01-placeholder', 'slides.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'audio', 'ATTRIBUTION.md'))).toBe(true)
    expect(existsSync(path.join(outDir, 'audio', 'local', '.gitkeep'))).toBe(true)

    const gitignore = readFileSync(path.join(outDir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('audio/local/')
    expect(gitignore).toContain('node_modules')

    const slidevConfig = readFileSync(path.join(outDir, 'slidev.config.ts'), 'utf8')
    expect(slidevConfig).toContain('plantuml: false')

    const onDisk = JSON.parse(readFileSync(path.join(outDir, 'course.json'), 'utf8'))
    expect(onDisk.targetRepo).toBe(path.resolve(repoDir))
    expect(onDisk.pinnedCommit).toBe(pinned)
  })

  it('adds optional git submodule at pinned commit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'course-kit-sub-'))
    tempDirs.push(root)
    const repoDir = path.join(root, 'target')
    await mkdir(repoDir, { recursive: true })
    const pinned = initBareRepo(repoDir, 'app.txt')

    const outDir = path.join(root, 'sub-course')
    const { course } = await runInit({
      targetRepo: repoDir,
      outDir,
      languages: ['en'],
      submodule: true,
      cwd: root,
    })

    expect(course.referenceMode).toBe('submodule')
    expect(course.submodulePath).toBe(SUBMODULE_PATH)
    expect(existsSync(path.join(outDir, SUBMODULE_PATH, 'app.txt'))).toBe(true)
    const subHead = execFileSync(
      'git',
      ['-C', path.join(outDir, SUBMODULE_PATH), 'rev-parse', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).trim()
    expect(subHead).toBe(pinned)
  })
})
