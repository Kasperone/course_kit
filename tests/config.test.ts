import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { runContext } from '../src/commands/context.js'
import { PLANTUML_DISABLED_SERVER, TARGET_REPO_ENV } from '../src/commands/init.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { makeWorkspace } from './helpers/fixture-repo.js'

function editJson(file: string, edit: (obj: Record<string, unknown>) => void): void {
  const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  edit(obj)
  writeFileSync(file, JSON.stringify(obj, null, 2))
}

const lessonJson = (ws: string, id = '01-placeholder') =>
  path.join(ws, 'lessons', id, 'lesson.json')

afterEach(() => {
  delete process.env[TARGET_REPO_ENV]
})

describe('lesson ids', () => {
  it.each(['../../outside/lessons/x', '..', 'a/b', '', '.hidden', 'x\ny'])(
    'course context rejects %j before touching the filesystem',
    async (id) => {
      const { root, workspace } = await makeWorkspace()
      mkdirSync(path.join(root, 'outside', 'lessons', 'x'), { recursive: true })
      writeFileSync(path.join(root, 'outside', 'lessons', 'x', 'lesson.json'), '{"globs":["**"]}')
      await expect(runContext({ lessonId: id, cwd: workspace })).rejects.toThrow(
        /Invalid lesson id/,
      )
      expect(existsSync(path.join(root, 'outside', 'lessons', 'x', 'context-pack.md'))).toBe(false)
    },
  )

  it('course lesson new rejects traversal', async () => {
    const { workspace } = await makeWorkspace()
    expect(() => runLessonNew({ lessonId: '../../evil', cwd: workspace })).toThrow(
      /Invalid lesson id/,
    )
  })

  it('lesson new writes valid YAML frontmatter with PlantUML disabled', async () => {
    const { workspace } = await makeWorkspace()
    const { lessonRoot } = runLessonNew({ lessonId: '02-billing', cwd: workspace })
    for (const lang of ['pl', 'en']) {
      const text = readFileSync(path.join(lessonRoot, lang, 'slides.md'), 'utf8')
      const fm = parseYaml(text.match(/^---\n([\s\S]*?)\n---/)![1]!) as Record<string, string>
      expect(fm.title).toBe(lang === 'pl' ? 'Lekcja: 02-billing' : 'Lesson: 02-billing')
      expect(fm.lang).toBe(lang)
      expect(fm.plantUmlServer).toBe(PLANTUML_DISABLED_SERVER)
    }
  })
})

describe('course.json validation', () => {
  it.each([
    ['HEAD', /full lowercase commit SHA/],
    ['main', /full lowercase commit SHA/],
    ['--output=/tmp/pwned', /full lowercase commit SHA/],
    ['ABCDEF0123456789ABCDEF0123456789ABCDEF01', /full lowercase commit SHA/],
  ])('rejects pinnedCommit %j', async (pinnedCommit, message) => {
    const { workspace } = await makeWorkspace()
    editJson(path.join(workspace, 'course.json'), (c) => {
      c.pinnedCommit = pinnedCommit
    })
    await expect(runContext({ lessonId: '01-placeholder', cwd: workspace })).rejects.toThrow(
      message,
    )
  })

  it('rejects languages that would escape the workspace', async () => {
    const { root, workspace } = await makeWorkspace()
    editJson(path.join(workspace, 'course.json'), (c) => {
      c.languages = ['en', '../../../../escaped-by-coursejson']
    })
    expect(() => runLessonNew({ lessonId: '03-x', cwd: workspace })).toThrow(/language code/)
    expect(existsSync(path.join(root, 'escaped-by-coursejson'))).toBe(false)
    expect(existsSync(path.join(workspace, 'lessons', '03-x'))).toBe(false)
  })

  it('rejects a submodulePath outside the workspace', async () => {
    const { workspace } = await makeWorkspace()
    editJson(path.join(workspace, 'course.json'), (c) => {
      c.referenceMode = 'submodule'
      c.submodulePath = '../elsewhere'
    })
    await expect(runContext({ lessonId: '01-placeholder', cwd: workspace })).rejects.toThrow(
      /submodulePath/,
    )
  })

  it('reports invalid JSON clearly', async () => {
    const { workspace } = await makeWorkspace()
    writeFileSync(path.join(workspace, 'course.json'), '{ not json')
    await expect(runContext({ lessonId: '01-placeholder', cwd: workspace })).rejects.toThrow(
      /course\.json is not valid JSON/,
    )
  })
})

describe('lesson.json validation', () => {
  it('treats missing files/globs as empty instead of crashing', async () => {
    const { workspace } = await makeWorkspace()
    writeFileSync(lessonJson(workspace), JSON.stringify({ globs: ['README.md'] }))
    const meta = await runContext({ lessonId: '01-placeholder', cwd: workspace })
    expect(meta.selectedFiles).toEqual(['README.md'])
  })

  it.each([
    [{ files: 'README.md' }, /"files" must be an array/],
    [{ globs: [42] }, /globs\[0\] must be a non-empty string/],
    [{ globs: ['../secrets/**'] }, /without ".."/],
    [{ files: ['/etc/passwd'] }, /without ".."/],
    [{ id: 'other-lesson' }, /does not match the lesson directory/],
    [{ limits: { maxSelectedFiles: 0 } }, /positive integer/],
    [{ limits: { bogus: 1 } }, /unknown limit "bogus"/],
    [{ focus: 3 }, /"focus" must be a string/],
  ])('rejects %j with a clear error', async (content, message) => {
    const { workspace } = await makeWorkspace()
    writeFileSync(lessonJson(workspace), JSON.stringify(content))
    await expect(runContext({ lessonId: '01-placeholder', cwd: workspace })).rejects.toThrow(
      message,
    )
  })
})

describe('target repo resolution', () => {
  it('reads the checked-out submodule in submodule mode, even if the original path is gone', async () => {
    const fx = await makeWorkspace(undefined, { submodule: true })
    renameSync(fx.repoDir, path.join(fx.root, 'moved-away'))
    const meta = await runContext({ lessonId: '01-placeholder', cwd: fx.workspace })
    expect(meta.pinnedCommit).toBe(fx.pinned)
    expect(meta.selectedFiles).toContain('README.md')
  })

  it('honours COURSE_TARGET_REPO for a clone at another path', async () => {
    const fx = await makeWorkspace()
    const moved = path.join(fx.root, 'clone-elsewhere')
    renameSync(fx.repoDir, moved)
    await expect(runContext({ lessonId: '01-placeholder', cwd: fx.workspace })).rejects.toThrow()
    process.env[TARGET_REPO_ENV] = moved
    const meta = await runContext({ lessonId: '01-placeholder', cwd: fx.workspace })
    expect(meta.pinnedCommit).toBe(fx.pinned)
  })
})
