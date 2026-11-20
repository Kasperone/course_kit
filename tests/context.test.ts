import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJavaAnalyzer, importedPackage, parseJdepsSummary } from '../src/analyzers/java.js'
import type { AnalyzerContext } from '../src/analyzers/types.js'
import { runContext } from '../src/commands/context.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { buildContextPack } from '../src/lib/context-pack/build.js'
import { readLessonJson, writeLessonJson, type LessonJson } from '../src/lib/lesson.js'
import { resolveWorkspace } from '../src/lib/workspace.js'
import { makeWorkspace, writeJavaSampleRepo } from './helpers/fixture-repo.js'
import { commitAll, initRepo, writeFiles } from './helpers/git.js'

const LESSON = '01-placeholder'

function setLesson(workspace: string, patch: Partial<LessonJson>): void {
  const root = path.join(workspace, 'lessons', LESSON)
  writeLessonJson(root, { ...readLessonJson(root), files: [], globs: [], ...patch })
}

function readPack(workspace: string): string {
  return readFileSync(path.join(workspace, 'lessons', LESSON, 'context-pack.md'), 'utf8')
}

/** Headings outside fenced code blocks (CommonMark fence rules). */
function structuralHeadings(md: string): string[] {
  const headings: string[] = []
  let open: { ch: string; len: number } | null = null
  for (const line of md.split('\n')) {
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
