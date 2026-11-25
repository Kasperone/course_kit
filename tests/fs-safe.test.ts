import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runContext } from '../src/commands/context.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { runPin } from '../src/commands/pin.js'
import { writeFileInside } from '../src/lib/fs-safe.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { commitAll, writeFiles } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

function outsideFile(root: string): string {
  const file = path.join(root, 'victim.txt')
  writeFileSync(file, 'original\n')
  return file
}

describe('symlink-safe workspace writes', () => {
  it('writeFileInside refuses a symlinked file or directory below the base', () => {
    const root = makeTempDir('safe')
    const base = path.join(root, 'ws')
    mkdirSync(base)
    const victim = outsideFile(root)

    symlinkSync(victim, path.join(base, 'link.txt'))
    expect(() => writeFileInside(base, path.join(base, 'link.txt'), 'x')).toThrow(/symlink/)

    symlinkSync(root, path.join(base, 'dir'))
    expect(() => writeFileInside(base, path.join(base, 'dir', 'victim.txt'), 'x')).toThrow(
      /symlink/,
    )
    expect(() => writeFileInside(base, path.join(root, 'victim.txt'), 'x')).toThrow(/escapes/)
    expect(readFileSync(victim, 'utf8')).toBe('original\n')

    writeFileInside(base, path.join(base, 'a', 'b', 'ok.txt'), 'ok')
    expect(readFileSync(path.join(base, 'a', 'b', 'ok.txt'), 'utf8')).toBe('ok')
  })

  it('course context refuses a symlinked context-pack.md', async () => {
    const { root, workspace } = await makeWorkspace()
    const victim = outsideFile(root)
    symlinkSync(victim, path.join(workspace, 'lessons', '01-placeholder', 'context-pack.md'))
    await expect(runContext({ lessonId: '01-placeholder', cwd: workspace })).rejects.toThrow(
      /symlink/,
    )
    expect(readFileSync(victim, 'utf8')).toBe('original\n')
  })

  it('course lesson new refuses a symlinked lessons/ directory', async () => {
    const { root, workspace } = await makeWorkspace()
    const elsewhere = path.join(root, 'elsewhere')
    renameSync(path.join(workspace, 'lessons'), elsewhere)
    symlinkSync(elsewhere, path.join(workspace, 'lessons'))
    expect(() => runLessonNew({ lessonId: '02-x', cwd: workspace })).toThrow(/symlink/)
  })

  it('course pin refuses a symlinked course.json', async () => {
    const { root, repoDir, workspace } = await makeWorkspace()
    const real = path.join(root, 'real-course.json')
    renameSync(path.join(workspace, 'course.json'), real)
    symlinkSync(real, path.join(workspace, 'course.json'))
    writeFiles(repoDir, { 'NEW.md': 'x\n' })
    commitAll(repoDir, 'next')
    expect(() => runPin({ cwd: workspace })).toThrow(/symlink/)
  })
})
