import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createJavaAnalyzer,
  importedPackage,
  parseJdepsSummary,
  type JdepsRunner,
} from '../src/analyzers/java.js'
import type { AnalyzerContext } from '../src/analyzers/types.js'
import { jsonPathFor, runContext } from '../src/commands/context.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { buildContextPack } from '../src/lib/context-pack/build.js'
import { escapeControls } from '../src/lib/context-pack/markdown.js'
import { terminalSafe } from '../src/lib/terminal.js'
import { readLessonJson, writeLessonJson, type LessonJson } from '../src/lib/lesson.js'
import { resolveWorkspace } from '../src/lib/workspace.js'
import { makeWorkspace, writeJavaSampleRepo } from './helpers/fixture-repo.js'
import { makeTempDir } from './helpers/tmp.js'
import { commitAll, git, initRepo, writeFiles } from './helpers/git.js'

const LESSON = '01-placeholder'

function setLesson(workspace: string, patch: Partial<LessonJson>): void {
  const root = path.join(workspace, 'lessons', LESSON)
  writeLessonJson(root, { ...readLessonJson(root), files: [], globs: [], ...patch })
}

function readPack(workspace: string): string {
  return readFileSync(path.join(workspace, 'lessons', LESSON, 'context-pack.md'), 'utf8')
}

/** Headings outside fenced code blocks (CommonMark fence rules; \n, \r\n and \r end a line). */
function structuralHeadings(md: string): string[] {
  const headings: string[] = []
  let open: { ch: string; len: number } | null = null
  for (const line of md.split(/\r\n|\r|\n/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (open) {
      if (f && f[1]![0] === open.ch && f[1]!.length >= open.len && f[2]!.trim() === '') open = null
      continue
    }
    if (f) {
      open = { ch: f[1]![0]!, len: f[1]!.length }
      continue
    }
    if (/^#{1,6} /.test(line)) headings.push(line)
  }
  return headings
}

describe('course context', () => {
  it('builds a pack from the pinned commit with the Java analyzer fallback', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { globs: ['src/**/*.java', 'README.md'] })

    const meta = await runContext({ lessonId: LESSON, json: true, cwd: fx.workspace })
    expect(meta.pinnedCommit).toBe(fx.pinned)
    expect(meta.selectedFiles).toContain('src/main/java/com/example/App.java')
    expect(meta.relatedTests).toContain('src/test/java/com/example/AppTest.java')
    expect(meta.analyzers).toContain('java')
    expect(meta.targetRepo).toBe('../target')

    const md = readPack(fx.workspace)
    expect(md).toContain(fx.pinned)
    expect(md).toContain('## Selection report')
    expect(md).toContain('## Size estimate')
    expect(md).toContain('flowchart LR')
    expect(md).not.toContain(fx.root)
    expect(existsSync(path.join(fx.workspace, 'lessons', LESSON, 'context-pack.json'))).toBe(true)

    // Working-tree edits and later commits do not leak into the pack.
    writeFileSync(path.join(fx.repoDir, 'src/main/java/com/example/App.java'), '// mutated\n')
    commitAll(fx.repoDir, 'later commit')
    writeFileSync(path.join(fx.repoDir, 'README.md'), '# uncommitted\n')
    const meta2 = await runContext({ lessonId: LESSON, cwd: fx.workspace })
    const md2 = readPack(fx.workspace)
    expect(md2).toContain('package com.example')
    expect(md2).not.toContain('// mutated')
    expect(md2).not.toContain('# uncommitted')
    expect(meta2.pinnedCommit).toBe(fx.pinned)
  })

  it('handles non-ASCII paths (Polish names) via NUL-separated git output', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'src/main/java/com/example/zażółć/Faktura.java':
          'package com.example.zazolc;\npublic class Faktura { String nazwa = "gęślą jaźń"; }\n',
        'src/dir with spaces/notatka.md': '# Notatka\n',
      })
      return commitAll(dir, 'polish')
    })
    setLesson(fx.workspace, { globs: ['src/**'] })
    const meta = await runContext({ lessonId: LESSON, cwd: fx.workspace })
    expect(meta.selectedFiles).toEqual([
      'src/dir with spaces/notatka.md',
      'src/main/java/com/example/zażółć/Faktura.java',
    ])
    const md = readPack(fx.workspace)
    expect(md).toContain('gęślą jaźń')
    expect(md).toContain('`src/main/java/com/example/zażółć/Faktura.java`')
    expect(md).not.toContain('\\305')
  })

  it('treats lesson.json files as literal paths and reports missing ones', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'app/[id]/page.tsx': 'export default function Page() {}\n',
        'app/i/page.tsx': 'export const decoy = 1\n',
      })
      return commitAll(dir, 'next')
    })
    setLesson(fx.workspace, { files: ['app/[id]/page.tsx', 'app/missing.ts'] })
    const meta = await runContext({ lessonId: LESSON, cwd: fx.workspace })
    expect(meta.selectedFiles).toEqual(['app/[id]/page.tsx'])
    expect(meta.missingFiles).toEqual(['app/missing.ts'])
    expect(meta.warnings.join('\n')).toContain('app/missing.ts')
    expect(readPack(fx.workspace)).toContain('not found at the pinned commit')
  })

  it('reports files over the cap instead of dropping them silently; limits are configurable', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      const files: Record<string, string> = {}
      for (let i = 1; i <= 61; i++) files[`src/a/C${i}.java`] = `package a;\nclass C${i} {}\n`
      files['src/big.txt'] = 'x'.repeat(200_000)
      writeFiles(dir, files)
      return commitAll(dir, 'many')
    })
    setLesson(fx.workspace, { globs: ['src/**'] })
    const meta = await runContext({ lessonId: LESSON, json: true, cwd: fx.workspace })
    expect(meta.matchedFiles).toBe(62)
    expect(meta.selectedFiles).toHaveLength(40)
    expect(meta.skipped.filter((s) => s.reason === 'over-cap')).toHaveLength(21)
    expect(meta.skipped).toContainEqual(
      expect.objectContaining({ path: 'src/big.txt', reason: 'too-large' }),
    )
    expect(meta.warnings.join('\n')).toMatch(/21 matching file\(s\) exceeded the caps/)
    const md = readPack(fx.workspace)
    expect(md).toContain('| over-cap | 21 |')

    setLesson(fx.workspace, {
      globs: ['src/**'],
      limits: { maxSelectedFiles: 100, maxFileBytes: 300_000 },
    })
    const meta2 = await runContext({ lessonId: LESSON, cwd: fx.workspace })
    expect(meta2.selectedFiles).toHaveLength(62)
    expect(meta2.skipped).toEqual([])
  })

  it('embeds README and code without breaking the pack structure', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'README.md':
          '# Target\n\n```bash\nnpm install\n```\n\n## AFTER-FENCE heading\n\n````md\n```nested```\n````\n',
        'AGENTS.md': '# Agents\n\n```\n# not a heading\n```\n',
        'docs/guide.md': '# Guide\n\n```js\nconst x = 1\n```\n\n## GUIDE-SECTION\n',
      })
      return commitAll(dir, 'docs')
    })
    setLesson(fx.workspace, { globs: ['docs/**'] })
    await runContext({ lessonId: LESSON, cwd: fx.workspace })
    const headings = structuralHeadings(readPack(fx.workspace))
    expect(headings).toEqual([
      '# Context pack',
      '## Selection report',
      '## Repository tree (pinned commit)',
      '## Project docs (excerpts)',
      '### `README.md`',
      '### `AGENTS.md`',
      '## Selected sources (line-numbered)',
      '### `docs/guide.md`',
      '## Related tests (heuristic)',
      '## Recent history (selected paths)',
      '## Language-specific analysis',
      '## Size estimate',
    ])
  })

  it('keeps control characters in file names and commit subjects out of the pack structure', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'src/x\r## INJECTED-CR': 'a\n',
        'src/y\n## INJECTED-LF': 'b\n',
      })
      git(dir, ['add', '-A'])
      git(dir, ['commit', '-q', '-m', 'subject\r## INJECTED-LOG'])
      return git(dir, ['rev-parse', 'HEAD']).trim()
    })
    setLesson(fx.workspace, { globs: ['src/**'] })
    await runContext({ lessonId: LESSON, cwd: fx.workspace })
    const md = readPack(fx.workspace)
    expect(structuralHeadings(md).filter((h) => /^#+ INJECTED/.test(h))).toEqual([])
    expect(md).toContain('`src/x\\r## INJECTED-CR`')
    // Only \t and \n may appear raw (inside fences); no other control character reaches the pack.
    // eslint-disable-next-line no-control-regex
    expect(md).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
  })

  it('a PlantUML block in a target README does not trip the workspace PlantUML guard', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'README.md': '# Target\n\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n',
        'src/app.ts': 'export const x = 1\n',
      })
      return commitAll(dir, 'readme with plantuml')
    })
    // README is not a selected source, so it lands in "Project docs (excerpts)".
    setLesson(fx.workspace, { globs: ['src/**'] })
    await runContext({ lessonId: LESSON, cwd: fx.workspace })
    const guard = path.join(fx.workspace, 'scripts', 'check-no-plantuml.mjs')
    execFileSync(process.execPath, [guard, fx.workspace], { stdio: 'pipe' })
    expect(readPack(fx.workspace)).toContain('     3|```plantuml')
  })

  it('redacts secrets in commit subjects and counts them in the report', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, { 'src/app.ts': 'export const x = 1\n' })
      return commitAll(dir, `rotate key ${token}`)
    })
    setLesson(fx.workspace, { globs: ['src/**'] })
    const meta = await runContext({ lessonId: LESSON, json: true, cwd: fx.workspace })
    const md = readPack(fx.workspace)
    expect(md).not.toContain(token)
    expect(md).toContain('rotate key')
    expect(meta.redactions).toContainEqual(expect.objectContaining({ path: '(git log)', count: 1 }))
  })

  it('reports symlinks, gitlinks and binary-by-content files as skipped, never as embedded', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'src/app.ts': 'export const a = 1\n',
        'src/blob.ts': Buffer.from([0x61, 0x00, 0x62]),
      })
      symlinkSync('../src/app.ts', path.join(dir, 'test-link.ts'))
      mkdirSync(path.join(dir, 'test'))
      symlinkSync('../src/app.ts', path.join(dir, 'test', 'app.test.ts'))
      git(dir, ['add', '-A'])
      const sha = commitAll(dir, 'files')
      git(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},vendor/lib`])
      git(dir, ['commit', '-q', '-m', 'gitlink'])
      return git(dir, ['rev-parse', 'HEAD']).trim()
    })
    setLesson(fx.workspace, { globs: ['src/**', 'vendor/**', 'test-link.ts'] })
    const meta = await runContext({ lessonId: LESSON, json: true, cwd: fx.workspace })
    const reasons = Object.fromEntries(meta.skipped.map((s) => [s.path, s.reason]))
    expect(reasons).toEqual({
      'src/blob.ts': 'binary',
      'test-link.ts': 'symlink',
      'test/app.test.ts': 'symlink',
      'vendor/lib': 'submodule',
    })
    expect(meta.selectedFiles).toEqual(['src/app.ts'])
    expect(meta.relatedTests).toEqual([])
    const md = readPack(fx.workspace)
    expect(md).toContain('embedded **1** selected file(s) and **0** related test(s)')
    expect(md).not.toContain('### `src/blob.ts`')
  })

  it('does not embed README twice when it is a selected source', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    await runContext({ lessonId: LESSON, cwd: fx.workspace })
    const md = readPack(fx.workspace)
    expect(md).toContain('_Included in full under Selected sources._')
    expect(md.match(/# Sample Java app/g)).toHaveLength(1)
  })

  it('course lesson new creates lesson.json with the default source globs', async () => {
    const fx = await makeWorkspace(writeJavaSampleRepo, { languages: ['en'] })
    const { lessonRoot } = runLessonNew({ lessonId: '02-billing', cwd: fx.workspace })
    const lesson = readLessonJson(lessonRoot)
    expect(lesson.globs).toEqual(['README.md', 'src/**', 'lib/**', 'backend/**', 'frontend/**'])
    expect(existsSync(path.join(lessonRoot, 'en', 'slides.md'))).toBe(true)
  })

  it('selects a Spring backend/ + frontend/ layout with the default globs', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'README.md': '# Faktura-like\n',
        'backend/src/main/java/io/x/App.java':
          'package io.x;\nimport io.x.api.Api;\nclass App {}\n',
        'backend/src/main/java/io/x/api/Api.java': 'package io.x.api;\npublic class Api {}\n',
        'frontend/src/main.ts': 'console.log(1)\n',
      })
      return commitAll(dir, 'layout')
    })
    runLessonNew({ lessonId: '02-layout', cwd: fx.workspace })
    const meta = await runContext({ lessonId: '02-layout', cwd: fx.workspace })
    expect(meta.selectedFiles).toEqual([
      'README.md',
      'backend/src/main/java/io/x/App.java',
      'backend/src/main/java/io/x/api/Api.java',
      'frontend/src/main.ts',
    ])
    expect(meta.analyzers).toEqual(['java'])
  })
})

describe('control characters', () => {
  it.each([
    ['\x1b]0;TITLE\x07', '\\x1b]0;TITLE\\x07'],
    ['\x1b[31mred', '\\x1b[31mred'],
    ['a\rb\nc\td', 'a\\rb\\nc\\td'],
    ['\u009b31m\u009d0;x\u009c', '\\x9b31m\\x9d0;x\\x9c'],
    ['a\u202eb\u2066c', 'a\\u202eb\\u2066c'],
    ['plain ünïcode ✓', 'plain ünïcode ✓'],
  ])('escapeControls(%j)', (input, expected) => {
    expect(escapeControls(input)).toBe(expected)
  })

  it('terminalSafe keeps line breaks but escapes everything else', () => {
    const out = terminalSafe('warning: a\x1b[2Jb\r\nsecond line\rspoof\nthird\x07')
    expect(out).toBe('warning: a\\x1b[2Jb\nsecond line\\rspoof\nthird\\x07')
  })
})

describe('--out', () => {
  it('jsonPathFor swaps .md for .json and appends otherwise', () => {
    expect(jsonPathFor('a/pack.md')).toBe('a/pack.json')
    expect(jsonPathFor('a/PACK.MD')).toBe('a/PACK.json')
    expect(jsonPathFor('a/pack.txt')).toBe('a/pack.txt.json')
  })

  it('creates missing parent directories, inside the workspace and outside it', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    const inside = path.join(fx.workspace, 'notes', 'deep', 'pack.md')
    await runContext({ lessonId: LESSON, out: inside, json: true, cwd: fx.workspace })
    expect(existsSync(inside)).toBe(true)
    expect(existsSync(path.join(fx.workspace, 'notes', 'deep', 'pack.json'))).toBe(true)

    const outside = path.join(fx.root, 'elsewhere', 'new', 'pack.md')
    await runContext({ lessonId: LESSON, out: outside, json: true, cwd: fx.workspace })
    expect(readFileSync(outside, 'utf8')).toContain('# Context pack')
    expect(existsSync(path.join(fx.root, 'elsewhere', 'new', 'pack.json'))).toBe(true)
  })

  it('treats a workspace directory named like "..notes" as inside, so symlinks are refused', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    const outsideDir = path.join(fx.root, 'victim-dir')
    mkdirSync(outsideDir)
    // A plain `..notes` directory works like any other directory of the workspace ...
    const plain = path.join(fx.workspace, '..plain', 'pack.md')
    await runContext({ lessonId: LESSON, out: plain, cwd: fx.workspace })
    expect(existsSync(plain)).toBe(true)
    // ... and a symlinked one is refused instead of written through.
    symlinkSync(outsideDir, path.join(fx.workspace, '..notes'))
    await expect(
      runContext({
        lessonId: LESSON,
        out: path.join(fx.workspace, '..notes', 'pack.md'),
        cwd: fx.workspace,
      }),
    ).rejects.toThrow(/symlink/)
    expect(existsSync(path.join(outsideDir, 'pack.md'))).toBe(false)
  })
})

describe('partial clones', () => {
  /** Target = `--filter=blob:none` clone of a sibling repository that could serve the blobs. */
  function writePartialClone(repoDir: string): string {
    const origin = path.join(path.dirname(repoDir), 'origin')
    writeJavaSampleRepo(origin)
    git(origin, ['config', 'uploadpack.allowFilter', 'true'])
    git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    git(path.dirname(repoDir), [
      'clone',
      '-q',
      '--no-checkout',
      '--filter=blob:none',
      `file://${origin}`,
      repoDir,
    ])
    return git(repoDir, ['rev-parse', 'HEAD']).trim()
  }

  it('never fetches missing blobs from the target remote and says what to do', async () => {
    const fx = await makeWorkspace(writePartialClone)
    setLesson(fx.workspace, { files: ['README.md'] })
    await expect(runContext({ lessonId: LESSON, cwd: fx.workspace })).rejects.toThrow(
      /partial clone.*COURSE_TARGET_REPO/s,
    )
    // The blob is still absent: git did not run `git fetch` against the clone's origin.
    const oid = git(fx.repoDir, ['rev-parse', `${fx.pinned}:README.md`]).trim()
    expect(() =>
      execFileSync('git', ['-C', fx.repoDir, 'cat-file', '-e', oid], {
        stdio: 'pipe',
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      }),
    ).toThrow()
  })

  it('also reports git versions that fail on the blocked fetch instead of printing "missing"', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    const bin = makeTempDir('git-old-promisor')
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = --batch ]; then echo "fatal: could not fetch abc from promisor remote" >&2; exit 128; fi\ndone\n' +
        'PATH="${PATH#*:}" exec git "$@"\n',
    )
    chmodSync(path.join(bin, 'git'), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`
    try {
      await expect(runContext({ lessonId: LESSON, cwd: fx.workspace })).rejects.toThrow(
        /partial clone/,
      )
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('runContext options', () => {
  it('resolves a relative --out against options.cwd', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    expect(process.cwd()).not.toBe(fx.workspace)
    await runContext({ lessonId: LESSON, out: 'notes/pack.md', json: true, cwd: fx.workspace })
    expect(existsSync(path.join(fx.workspace, 'notes', 'pack.md'))).toBe(true)
    expect(existsSync(path.join(fx.workspace, 'notes', 'pack.json'))).toBe(true)
    expect(existsSync(path.resolve('notes', 'pack.md'))).toBe(false)
  })

  it('validates --files globs like lesson.json ones', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    for (const bad of ['../x/**', '/etc/passwd', 'src\\main/**']) {
      await expect(
        runContext({ lessonId: LESSON, files: [bad], cwd: fx.workspace }),
        bad,
      ).rejects.toThrow(/--files must be relative to the target repo root/)
    }
    const ok = await runContext({ lessonId: LESSON, files: ['src/**'], cwd: fx.workspace })
    expect(ok.selectedFiles).toContain('src/main/java/com/example/App.java')
  })
})

describe('git history failures', () => {
  it('reports a failed git log in the warnings instead of "No log entries"', async () => {
    const fx = await makeWorkspace()
    setLesson(fx.workspace, { files: ['README.md'] })
    // `git log` fails (as it would on a timeout or a path list too long for the command line).
    const bin = makeTempDir('git-log-fails')
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = log ]; then echo "fatal: simulated log failure" >&2; exit 128; fi\ndone\n' +
        'PATH="${PATH#*:}" exec git "$@"\n',
    )
    chmodSync(path.join(bin, 'git'), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`
    try {
      const meta = await runContext({ lessonId: LESSON, cwd: fx.workspace })
      expect(meta.warnings.join('\n')).toMatch(
        /history .* could not be read \(fatal: simulated log failure\)/,
      )
    } finally {
      process.env.PATH = savedPath
    }
    const md = readPack(fx.workspace)
    expect(md).toContain('history is missing from this pack')
    expect(md).not.toContain('_No log entries._')

    // Control: a healthy git lists the commit.
    const ok = await runContext({ lessonId: LESSON, cwd: fx.workspace })
    expect(ok.warnings.join('\n')).not.toMatch(/could not be read/)
    expect(readPack(fx.workspace)).toContain('java sample')
  })
})

describe('Java analyzer', () => {
  it('hands committed jar/class blobs to jdeps', async () => {
    const fx = await makeWorkspace((dir) => {
      initRepo(dir)
      writeFiles(dir, {
        'lib/a/tool.jar': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2]),
        'lib/b/tool.jar': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 3, 4]),
        'README.md': '# jars\n',
      })
      return commitAll(dir, 'jars')
    })
    setLesson(fx.workspace, { globs: ['lib/**'] })
    const seen: Buffer[] = []
    const analyzer = createJavaAnalyzer((file) => {
      seen.push(readFileSync(file))
      return `${path.basename(file)} -> java.base\n${path.basename(file)} -> java.sql\n`
    })
    const ws = resolveWorkspace(fx.workspace)
    const lessonRoot = path.join(fx.workspace, 'lessons', LESSON)
    const meta = await buildContextPack({
      course: ws.course,
      repoPath: ws.targetRepoPath,
      lesson: readLessonJson(lessonRoot),
      cliFileGlobs: [],
      outMarkdown: path.join(lessonRoot, 'context-pack.md'),
      analyzers: [analyzer],
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]![7]).toBe(2)
    expect(seen[1]![7]).toBe(4)
    expect(meta.analyzers).toEqual(['java'])
    expect(meta.selectedFiles).toEqual([])
    const md = readPack(fx.workspace)
    expect(md).toContain('jdeps (2 compiled artifact(s) in selection)')
    expect(md).toContain('["lib/a/tool.jar"]')
    expect(md).toContain('["lib/b/tool.jar"]')
    expect(md).toContain('["java.sql"]')
  })

  it('never uses repository file names for temp files and probes jdeps before reading', async () => {
    const jar = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    const artifacts = [
      'lib/x\\y.jar',
      'lib/..\\..\\evil.JAR',
      'lib/noext',
      'lib/ünï.class',
      'lib/semi;colon.jar',
    ]
    const seen: string[] = []
    let reads = 0
    const ctx = (): AnalyzerContext => ({
      pinnedCommit: 'x',
      selectedPaths: [],
      readText: () => null,
      artifacts: artifacts.map((p) => ({
        path: p,
        size: jar.length,
        read: () => {
          reads++
          return jar
        },
      })),
    })

    const runner: JdepsRunner = (file) => {
      expect(readFileSync(file)).toEqual(jar) // the temp file exists where the runner is told
      seen.push(path.basename(file))
      return `${path.basename(file)} -> java.base\n`
    }
    const section = await createJavaAnalyzer(runner).analyze(ctx())
    expect(seen).toEqual(['0.jar', '1.jar', '2', '3.class', '4.jar'])
    // The graph is keyed by the repository paths again, never by temp names.
    expect(section!.markdown).toContain('["lib/noext"]')
    expect(section!.markdown).toContain('["lib/ünï.class"]')
    expect(section!.markdown).toContain('["lib/semi;colon.jar"]')
    expect(section!.markdown).not.toContain('["0.jar"]')

    // Without jdeps nothing is read from the object database or written to disk.
    reads = 0
    const missing: JdepsRunner = Object.assign(() => 'x -> y\n', { available: () => false })
    await createJavaAnalyzer(missing).analyze(ctx())
    expect(reads).toBe(0)
  })

  it('parses jdeps -summary output', () => {
    expect(parseJdepsSummary('app.jar -> java.base\napp.jar -> not found\n\n')).toEqual([
      ['app.jar', 'java.base'],
      ['app.jar', 'not found'],
    ])
  })

  it.each([
    ['a.b.C', false, false, 'a.b'],
    ['a.b.C.Inner', false, false, 'a.b'],
    ['a.b', true, false, 'a.b'],
    ['a.b.C', true, false, 'a.b'],
    ['a.b.C.m', false, true, 'a.b'],
    ['a.b.C', true, true, 'a.b'],
    ['java.util', true, false, 'java.util'],
  ])('importedPackage(%s, wildcard=%s, static=%s) = %s', (name, wildcard, isStatic, expected) => {
    expect(importedPackage(name, wildcard, isStatic)).toBe(expected)
  })

  it('keeps distinct packages distinct and handles wildcard/static imports', async () => {
    const files: Record<string, string> = {
      'App.java':
        'package com.example;\nimport com.example.a_b.X;\nimport com.example.a.b.Y;\nimport java.util.*;\nimport static org.junit.Assert.assertTrue;\n',
    }
    const ctx: AnalyzerContext = {
      pinnedCommit: 'x',
      selectedPaths: Object.keys(files),
      readText: (p) => files[p] ?? null,
      artifacts: [],
    }
    const section = await createJavaAnalyzer(() => null).analyze(ctx)
    const md = section!.markdown
    for (const label of [
      'com.example',
      'com.example.a_b',
      'com.example.a.b',
      'java.util',
      'org.junit',
    ]) {
      expect(md).toContain(`["${label}"]`)
    }
    expect(md.match(/-->/g)).toHaveLength(4)
  })
})
