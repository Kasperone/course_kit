import { readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { runPin } from '../src/commands/pin.js'
import { uncommittedChanges } from '../src/lib/git.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { commitAll, git, initRepoWithCommit, writeFiles } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

const pinnedIn = (ws: string) =>
  (JSON.parse(readFileSync(path.join(ws, 'course.json'), 'utf8')) as { pinnedCommit: string })
    .pinnedCommit

describe('course pin', () => {
  it('pins the target HEAD by default and reports old -> new', async () => {
    const fx = await makeWorkspace()
    writeFiles(fx.repoDir, { 'NEW.md': 'new\n' })
    const next = commitAll(fx.repoDir, 'next')

    const result = runPin({ cwd: fx.workspace })
    expect(result).toMatchObject({ previous: fx.pinned, pinned: next, changed: true })
    expect(pinnedIn(fx.workspace)).toBe(next)
    expect(result.warnings.join('\n')).toMatch(/re-run `course context/)
    // Other course.json fields are kept.
    const course = JSON.parse(readFileSync(path.join(fx.workspace, 'course.json'), 'utf8'))
    expect(course.targetRepo).toBe('../target')
    expect(course.languages).toEqual(['pl', 'en'])
  })

  it('resolves branches, tags and short SHAs to a full SHA', async () => {
    const fx = await makeWorkspace()
    git(fx.repoDir, ['tag', 'v1'])
    writeFiles(fx.repoDir, { 'NEW.md': 'new\n' })
    const next = commitAll(fx.repoDir, 'next')

    expect(runPin({ cwd: fx.workspace, commit: 'v1' })).toMatchObject({ changed: false })
    expect(runPin({ cwd: fx.workspace, commit: next.slice(0, 8) }).pinned).toBe(next)
    expect(runPin({ cwd: fx.workspace, commit: 'HEAD~1' }).pinned).toBe(fx.pinned)
    expect(pinnedIn(fx.workspace)).toBe(fx.pinned)
  })

  it('leaves course.json untouched when nothing changes', async () => {
    const fx = await makeWorkspace()
    const file = path.join(fx.workspace, 'course.json')
    const before = readFileSync(file, 'utf8')
    const result = runPin({ cwd: fx.workspace })
    expect(result).toMatchObject({ previous: fx.pinned, pinned: fx.pinned, changed: false })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it.each([
    ['--output=/tmp/x', /Invalid revision/],
    ['-n', /Invalid revision/],
    ['HEAD..main', /Invalid revision/],
    ['a b', /Invalid revision/],
    ['does-not-exist', /not found/],
    ['0000000000000000000000000000000000000000', /not found/],
  ])('rejects %j without changing course.json', async (rev, error) => {
    const fx = await makeWorkspace()
    expect(() => runPin({ cwd: fx.workspace, commit: rev })).toThrow(error)
    expect(pinnedIn(fx.workspace)).toBe(fx.pinned)
  })

  it('warns about uncommitted changes in the target without touching its index', async () => {
    const fx = await makeWorkspace()
    writeFileSync(path.join(fx.repoDir, 'README.md'), '# changed\n')
    writeFileSync(path.join(fx.repoDir, 'untracked ż.txt'), 'x\n')
    const index = path.join(fx.repoDir, '.git', 'index')
    const mtime = statSync(index).mtimeMs

    expect(uncommittedChanges(fx.repoDir).sort()).toEqual(['README.md', 'untracked ż.txt'])
    const result = runPin({ cwd: fx.workspace })
    expect(result.changed).toBe(false)
    expect(result.warnings.join('\n')).toMatch(/2 uncommitted change\(s\).*README\.md/)
    expect(statSync(index).mtimeMs).toBe(mtime)
  })

  it('moves the submodule checkout to a new target commit (fetched from origin)', async () => {
    const fx = await makeWorkspace(undefined, { submodule: true })
    writeFiles(fx.repoDir, { 'NEW.md': 'new\n' })
    const next = commitAll(fx.repoDir, 'next')
    const sub = path.join(fx.workspace, 'target-repo')

    const result = runPin({ cwd: fx.workspace, commit: next })
    expect(result.pinned).toBe(next)
    expect(git(sub, ['rev-parse', 'HEAD']).trim()).toBe(next)
    expect(pinnedIn(fx.workspace)).toBe(next)
    expect(git(fx.workspace, ['ls-files', '-s', 'target-repo'])).toContain(next)
  })

  it('bare `course pin` in submodule mode pins the HEAD of the submodule origin', async () => {
    const fx = await makeWorkspace(undefined, { submodule: true })
    writeFiles(fx.repoDir, { 'NEW.md': 'new\n' })
    const next = commitAll(fx.repoDir, 'next')

    const result = runPin({ cwd: fx.workspace })
    expect(result.previous).toBe(fx.pinned)
    expect(result.pinned).toBe(next)
    expect(result.changed).toBe(true)
    expect(git(path.join(fx.workspace, 'target-repo'), ['rev-parse', 'HEAD']).trim()).toBe(next)
  })

  it('leaves the submodule and its gitlink alone when course.json cannot be written', async () => {
    const fx = await makeWorkspace(undefined, { submodule: true })
    writeFiles(fx.repoDir, { 'NEW.md': 'new\n' })
    const next = commitAll(fx.repoDir, 'next')
    const real = path.join(fx.root, 'real-course.json')
    renameSync(path.join(fx.workspace, 'course.json'), real)
    symlinkSync(real, path.join(fx.workspace, 'course.json'))

    expect(() => runPin({ cwd: fx.workspace, commit: next })).toThrow(/symlink/)
    const sub = path.join(fx.workspace, 'target-repo')
    expect(git(sub, ['rev-parse', 'HEAD']).trim()).toBe(fx.pinned)
    expect(git(fx.workspace, ['ls-files', '-s', 'target-repo'])).toContain(fx.pinned)
  })

  it('keeps course.json at the old pin when the submodule checkout cannot move', async () => {
    const fx = await makeWorkspace(undefined, { submodule: true })
    writeFiles(fx.repoDir, { 'app.txt': 'changed upstream\n' })
    const next = commitAll(fx.repoDir, 'next')
    // A local edit to the same file makes `git checkout` refuse to switch.
    writeFiles(path.join(fx.workspace, 'target-repo'), { 'app.txt': 'local edit\n' })

    expect(() => runPin({ cwd: fx.workspace, commit: next })).toThrow()
    expect(pinnedIn(fx.workspace)).toBe(fx.pinned)
  })
})

describe('course init uncommitted-changes warning', () => {
  it('warns when the target working tree is dirty', async () => {
    const root = makeTempDir('dirty')
    const target = path.join(root, 'target')
    initRepoWithCommit(target)
    writeFileSync(path.join(target, 'README.md'), '# dirty\n')

    const { warnings } = await runInit({
      targetRepo: target,
      outDir: path.join(root, 'course'),
      languages: ['en'],
      submodule: false,
    })
    expect(warnings.join('\n')).toMatch(/1 uncommitted change\(s\).*README\.md/)
  })

  it('has no warning for a clean target', async () => {
    const root = makeTempDir('clean')
    const target = path.join(root, 'target')
    initRepoWithCommit(target)
    const { warnings } = await runInit({
      targetRepo: target,
      outDir: path.join(root, 'course'),
      languages: ['en'],
      submodule: false,
    })
    expect(warnings).toEqual([])
  })
})
