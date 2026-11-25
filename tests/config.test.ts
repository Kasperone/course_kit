import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { runContext } from '../src/commands/context.js'
import { PLANTUML_DISABLED_SERVER, TARGET_REPO_ENV } from '../src/commands/init.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { assertTargetOutsideWorkspace, targetIsInsideByIdentity } from '../src/lib/workspace.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { git } from './helpers/git.js'

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

  it('lesson new writes valid YAML frontmatter with PlantUML, web fonts and CDN favicon off', async () => {
    const { workspace } = await makeWorkspace()
    const { lessonRoot } = runLessonNew({ lessonId: '02-billing', cwd: workspace })
    for (const lang of ['pl', 'en']) {
      const text = readFileSync(path.join(lessonRoot, lang, 'slides.md'), 'utf8')
      const fm = parseYaml(text.match(/^---\n([\s\S]*?)\n---/)![1]!) as Record<string, unknown>
      expect(fm.title).toBe(lang === 'pl' ? 'Lekcja: 02-billing' : 'Lesson: 02-billing')
      expect(fm.lang).toBe(lang)
      expect(fm.plantUmlServer).toBe(PLANTUML_DISABLED_SERVER)
      expect(fm.fonts).toEqual({
        sans: 'system-ui',
        serif: 'ui-serif',
        mono: 'ui-monospace',
        provider: 'none',
      })
      expect(fm.browserExporter).toBe(false)
      expect(fm.favicon).toBe('data:,')
      expect(fm.mcp).toBe(false)
    }
  })
})

describe('lesson new without the target', () => {
  it('works when no target path is known or the submodule is not checked out', async () => {
    const fx = await makeWorkspace()
    editJson(path.join(fx.workspace, 'course.json'), (c) => {
      c.targetRepo = null
    })
    expect(() => runLessonNew({ lessonId: '02-a', cwd: fx.workspace })).not.toThrow()

    editJson(path.join(fx.workspace, 'course.json'), (c) => {
      c.referenceMode = 'submodule'
      c.submodulePath = 'target-repo'
    })
    expect(existsSync(path.join(fx.workspace, 'target-repo'))).toBe(false)
    expect(() => runLessonNew({ lessonId: '02-b', cwd: fx.workspace })).not.toThrow()
    // Commands that read the target still say what is missing.
    await expect(runContext({ lessonId: '02-b', cwd: fx.workspace })).rejects.toThrow(
      /not checked out/,
    )
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

  it('reads the target path from course.local.json when course.json has none', async () => {
    const fx = await makeWorkspace()
    editJson(path.join(fx.workspace, 'course.json'), (c) => {
      c.targetRepo = null
    })
    await expect(runContext({ lessonId: '01-placeholder', cwd: fx.workspace })).rejects.toThrow(
      /course\.local\.json/,
    )
    writeFileSync(
      path.join(fx.workspace, 'course.local.json'),
      JSON.stringify({ targetRepo: fx.repoDir }),
    )
    const meta = await runContext({ lessonId: '01-placeholder', cwd: fx.workspace })
    expect(meta.pinnedCommit).toBe(fx.pinned)
    expect(meta.targetRepo).toBeNull()
  })

  it('honours COURSE_TARGET_REPO for a clone at another path', async () => {
    const fx = await makeWorkspace()
    const moved = path.join(fx.root, 'clone-elsewhere')
    renameSync(fx.repoDir, moved)
    await expect(runContext({ lessonId: '01-placeholder', cwd: fx.workspace })).rejects.toThrow(
      /Pinned commit [0-9a-f]{40} is not available/,
    )
    process.env[TARGET_REPO_ENV] = moved
    const meta = await runContext({ lessonId: '01-placeholder', cwd: fx.workspace })
    expect(meta.pinnedCommit).toBe(fx.pinned)
  })
})

/**
 * A cloned workspace can commit a bare repository's files (HEAD, objects/, refs/, config) and
 * point `targetRepo` at them. Git discovers implicit bare repos and honours their config, so
 * `log.showSignature` plus `gpg.program` would run a program on a commit with a gpgsig header.
 */
function plantBareRepo(dir: string, marker: string): string {
  git(path.dirname(dir), ['init', '-q', '--bare', path.basename(dir)])
  const gd = ['--git-dir', dir]
  const blobOid = execGit(dir, [...gd, 'hash-object', '-w', '--stdin'], '# hi\n')
  const tree = execGit(dir, [...gd, 'mktree'], `100644 blob ${blobOid}\tREADME.md\n`)
  const commit = execGit(
    dir,
    [...gd, 'hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor a <a@x> 0 +0000\ncommitter a <a@x> 0 +0000\n` +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----\n\nsigned\n',
  )
  const program = path.join(path.dirname(dir), 'gpg-pwn.sh')
  writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`)
  chmodSync(program, 0o755)
  writeFileSync(
    path.join(dir, 'config'),
    readFileSync(path.join(dir, 'config'), 'utf8') +
      `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${program}\n`,
  )
  return commit
}

function execGit(cwd: string, args: string[], input: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim()
}

describe('hostile workspace', () => {
  it('never runs a program from a bare repo committed inside the workspace', async () => {
    const fx = await makeWorkspace()
    const marker = path.join(fx.root, 'PWNED')
    const commit = plantBareRepo(path.join(fx.workspace, 'evil'), marker)
    editJson(path.join(fx.workspace, 'course.json'), (c) => {
      c.targetRepo = 'evil'
      c.pinnedCommit = commit
    })
    editJson(lessonJson(fx.workspace), (l) => {
      l.files = ['README.md']
      l.globs = []
    })

    await expect(runContext({ lessonId: '01-placeholder', cwd: fx.workspace })).rejects.toThrow(
      /inside the course workspace/,
    )
    expect(existsSync(marker)).toBe(false)

    // Even when the user points COURSE_TARGET_REPO at it, git refuses the implicit bare repo.
    process.env[TARGET_REPO_ENV] = path.join(fx.workspace, 'evil')
    await expect(runContext({ lessonId: '01-placeholder', cwd: fx.workspace })).rejects.toThrow(
      /safe\.bareRepository/,
    )
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a course.local.json target inside the workspace too', async () => {
    const fx = await makeWorkspace()
    editJson(path.join(fx.workspace, 'course.json'), (c) => {
      c.targetRepo = null
    })
    writeFileSync(
      path.join(fx.workspace, 'course.local.json'),
      JSON.stringify({ targetRepo: path.join(fx.workspace, 'lessons') }),
    )
    await expect(runContext({ lessonId: '01-placeholder', cwd: fx.workspace })).rejects.toThrow(
      /inside the course workspace/,
    )
  })
})

describe('target inside the workspace, by identity', () => {
  // A case-insensitive filesystem (macOS, Windows) resolves `../MY-COURSE/evil` into the workspace
  // `my-course/`, but the two spellings differ as strings. Simulated with a stat that treats
  // directories whose names match case-insensitively as the same inode.
  const caseInsensitiveStat = (p: string) => {
    const key = path.resolve(p).toLowerCase()
    let h = 0
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return { dev: 1, ino: h }
  }

  it('refuses a target whose path differs from the workspace only by case', async () => {
    const fx = await makeWorkspace()
    const spoofed = path.join(path.dirname(fx.workspace), 'COURSE', 'evil')
    // The string comparison alone calls this outside the workspace ...
    expect(() => assertTargetOutsideWorkspace(fx.workspace, spoofed)).not.toThrow()
    // ... the identity walk does not.
    expect(() => assertTargetOutsideWorkspace(fx.workspace, spoofed, caseInsensitiveStat)).toThrow(
      /inside the course workspace/,
    )
    expect(targetIsInsideByIdentity(fx.workspace, spoofed, caseInsensitiveStat)).toBe(true)
    expect(targetIsInsideByIdentity(fx.workspace, fx.repoDir, caseInsensitiveStat)).toBe(false)
  })

  it('walks up from the real path of the target', async () => {
    const fx = await makeWorkspace()
    expect(targetIsInsideByIdentity(fx.workspace, path.join(fx.workspace, 'a', 'b'))).toBe(true)
    expect(targetIsInsideByIdentity(fx.workspace, fx.workspace)).toBe(true)
    expect(targetIsInsideByIdentity(fx.workspace, fx.repoDir)).toBe(false)
  })
})
