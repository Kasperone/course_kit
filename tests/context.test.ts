import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runContext } from '../src/commands/context.js'
import { runInit } from '../src/commands/init.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { writeLessonJson, readLessonJson } from '../src/lib/lesson.js'
import { writeJavaSampleRepo } from './helpers/fixture-repo.js'

describe('course context', () => {
  it('builds a pack from pinned commit with Java analyzer fallback', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'course-kit-ctx-'))
    const repoDir = path.join(root, 'target')
    const pinned = writeJavaSampleRepo(repoDir)

    const workspace = path.join(root, 'course')
    await runInit({
      targetRepo: repoDir,
      outDir: workspace,
      languages: ['pl', 'en'],
      submodule: false,
      cwd: root,
    })

    const lessonRoot = path.join(workspace, 'lessons', '01-placeholder')
    const lesson = readLessonJson(lessonRoot)
    lesson.globs = ['src/**/*.java', 'README.md']
    writeLessonJson(lessonRoot, lesson)

    const meta = await runContext({
      lessonId: '01-placeholder',
      files: [],
      json: true,
      cwd: workspace,
    })

    expect(meta.pinnedCommit).toBe(pinned)
    expect(meta.selectedFiles.some((f) => f.endsWith('App.java'))).toBe(true)
    expect(meta.relatedTests).toContain('src/test/java/com/example/AppTest.java')
    expect(meta.analyzers).toContain('java')

    const md = readFileSync(path.join(lessonRoot, 'context-pack.md'), 'utf8')
    expect(md).toContain('Pinned commit')
    expect(md).toContain(pinned)
    expect(md).toContain('## Repository tree')
    expect(md).toContain('## Size estimate')
    expect(md).toContain('flowchart LR')
    expect(existsSync(path.join(lessonRoot, 'context-pack.json'))).toBe(true)

    writeFileSync(path.join(repoDir, 'src/main/java/com/example/App.java'), '// mutated\n', 'utf8')
    const meta2 = await runContext({ lessonId: '01-placeholder', files: [], cwd: workspace })
    const md2 = readFileSync(path.join(lessonRoot, 'context-pack.md'), 'utf8')
    expect(md2).toContain('package com.example')
    expect(md2).not.toContain('// mutated')
    expect(meta2.pinnedCommit).toBe(pinned)
  })

  it('course lesson new creates lesson.json and slides', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'course-kit-lesson-'))
    const repoDir = path.join(root, 'target')
    writeJavaSampleRepo(repoDir)
    const workspace = path.join(root, 'course')
    await runInit({
      targetRepo: repoDir,
      outDir: workspace,
      languages: ['en'],
      submodule: false,
      cwd: root,
    })
    const { lessonRoot } = runLessonNew({ lessonId: '02-billing', cwd: workspace })
    expect(existsSync(path.join(lessonRoot, 'lesson.json'))).toBe(true)
    expect(existsSync(path.join(lessonRoot, 'en', 'slides.md'))).toBe(true)
  })
})
