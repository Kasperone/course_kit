import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBuild, runDev } from '../src/commands/slidev.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import { findPlantUmlFiles, findPlantUmlServerRefs } from '../src/lib/slidev.js'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { makeTempDir } from './helpers/tmp.js'

const calls = (log: string): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
    : []

const deck = (ws: string, id: string, lang: string) =>
  path.join(ws, 'lessons', id, lang, 'slides.md')

describe('course build', () => {
  it('runs Slidev once per deck with absolute paths, hash routing and a deck base', async () => {
    const { workspace } = await makeWorkspace()
    const log = installFakeSlidev(workspace)
    runLessonNew({ lessonId: '02-billing', cwd: workspace })

    const result = runBuild({ cwd: workspace })
    expect(result.decks.map((d) => `${d.lessonId}/${d.lang}`)).toEqual([
      '01-placeholder/pl',
      '01-placeholder/en',
      '02-billing/pl',
      '02-billing/en',
    ])
    const argv = calls(log)
    expect(argv).toHaveLength(4)
    expect(argv[2]).toEqual([
      'build',
      deck(workspace, '02-billing', 'pl'),
      '--out',
      path.join(workspace, 'dist', '02-billing', 'pl'),
      '--base',
      '/02-billing/pl/',
      '--router-mode',
      'hash',
    ])
    for (const d of result.decks) expect(existsSync(path.join(d.outDir, 'index.html'))).toBe(true)
    const index = readFileSync(path.join(workspace, 'dist', 'index.html'), 'utf8')
    expect(index).toContain('href="./02-billing/en/"')
    expect(index).toContain('Lekcja: 02-billing')
    expect(argv.flat().join(' ')).not.toMatch(/export|playwright/i)
  })

  it('filters by --lesson and --lang and validates both', async () => {
    const { workspace } = await makeWorkspace()
    const log = installFakeSlidev(workspace)
    const result = runBuild({ cwd: workspace, lesson: '01-placeholder', lang: 'en' })
    expect(result.decks).toHaveLength(1)
    expect(calls(log)).toHaveLength(1)
    runBuild({ cwd: workspace, lesson: '01-placeholder', lang: 'pl' })
    // The index keeps decks from earlier (filtered) builds.
    const index = readFileSync(path.join(workspace, 'dist', 'index.html'), 'utf8')
    expect(index).toContain('href="./01-placeholder/en/"')
    expect(index).toContain('href="./01-placeholder/pl/"')
    expect(() => runBuild({ cwd: workspace, lang: 'de' })).toThrow(/not in course.json/)
    expect(() => runBuild({ cwd: workspace, lesson: '../x' })).toThrow(/Invalid lesson id/)
    expect(() => runBuild({ cwd: workspace, lesson: '09-missing' })).toThrow(/Unknown lesson/)
  })

  it('escapes deck titles in the index', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    const file = deck(workspace, '01-placeholder', 'en')
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/^title: .*$/m, 'title: "<script>x</script>"'),
    )
    runBuild({ cwd: workspace })
    const index = readFileSync(path.join(workspace, 'dist', 'index.html'), 'utf8')
    expect(index).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(index).not.toContain('<script>')
  })

  it.each([
    ['a fenced block', '```plantuml\n@startuml\nA -> B\n@enduml\n```\n'],
    ['a tilde fence', '~~~ plantuml\nA -> B\n~~~\n'],
    ['the component', '<PlantUml code="SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IW80" />\n'],
    ['the kebab-case component', '<plant-uml code="x" />\n'],
  ])('refuses to start Slidev when a deck contains %s', async (_what, body) => {
    const { workspace } = await makeWorkspace()
    const log = installFakeSlidev(workspace)
    writeFileSync(deck(workspace, '01-placeholder', 'en'), `# x\n\n${body}`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/PlantUML is not allowed.*01-placeholder/)
    expect(calls(log)).toHaveLength(0)
    await expect(
      Promise.resolve().then(() => runDev({ lesson: '01-placeholder', cwd: workspace })),
    ).rejects.toThrow(/PlantUML is not allowed/)
  })

  it('fails when the built output references a PlantUML server (render-time check)', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    // Not a PlantUML block, but the fake build copies it into index.html like a leaked default.
    writeFileSync(
      deck(workspace, '01-placeholder', 'en'),
      '---\nplantUmlServer: "https://www.plantuml.com/plantuml"\n---\n# x\n',
    )
    expect(() => runBuild({ cwd: workspace })).toThrow(/references a PlantUML server/)
  })

  it('asks for npm install when Slidev is missing', async () => {
    const { workspace } = await makeWorkspace()
    expect(() => runBuild({ cwd: workspace })).toThrow(/Slidev is not installed.*npm install/)
  })

  it('refuses a symlinked dist directory', async () => {
    const { root, workspace } = await makeWorkspace()
    installFakeSlidev(workspace)
    const outside = path.join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, path.join(workspace, 'dist'))
    expect(() => runBuild({ cwd: workspace })).toThrow(/symlink/)
    expect(existsSync(path.join(outside, '01-placeholder'))).toBe(false)
  })

  it('does not need the target repo (works on a cloned workspace)', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    const course = path.join(workspace, 'course.json')
    const json = JSON.parse(readFileSync(course, 'utf8'))
    writeFileSync(course, JSON.stringify({ ...json, targetRepo: '../gone' }))
    expect(runBuild({ cwd: workspace }).decks).toHaveLength(1)
  })
})

describe('course dev', () => {
  it('starts the Slidev dev server for one deck (default: first language)', async () => {
    const { workspace } = await makeWorkspace()
    const log = installFakeSlidev(workspace)
    expect(await runDev({ lesson: '01-placeholder', cwd: workspace, port: 3031 })).toBe(0)
    expect(calls(log)).toEqual([[deck(workspace, '01-placeholder', 'pl'), '--port', '3031']])
    expect(() => runDev({ lesson: '01-placeholder', cwd: workspace, port: 70000 })).toThrow(
      /Invalid port/,
    )
  })
})

describe('PlantUML scanners', () => {
  it('skip node_modules, dist and symlinks', () => {
    const dir = makeTempDir('scan')
    const block = '```plantuml\nA -> B\n```\n'
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules', 'x', 'README.md'), block)
    mkdirSync(path.join(dir, 'dist'))
    writeFileSync(path.join(dir, 'dist', 'a.md'), block)
    const elsewhere = makeTempDir('scan-target')
    writeFileSync(path.join(elsewhere, 'b.md'), block)
    symlinkSync(elsewhere, path.join(dir, 'linked'))
    mkdirSync(path.join(dir, 'lessons'))
    writeFileSync(path.join(dir, 'lessons', 'ok.md'), '```mermaid\nflowchart LR\n  a --> b\n```\n')
    expect(findPlantUmlFiles(dir)).toEqual([])
    writeFileSync(path.join(dir, 'lessons', 'Comp.vue'), '<template><PlantUml /></template>')
    expect(findPlantUmlFiles(dir)).toEqual(['lessons/Comp.vue'])
  })

  it('finds plantuml.com in built assets only', () => {
    const dir = makeTempDir('dist')
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'assets', 'a.js'), 'const s="data:text/plain,plantuml-disabled"')
    writeFileSync(path.join(dir, 'assets', 'logo.png'), 'https://www.plantuml.com')
    expect(findPlantUmlServerRefs(dir)).toEqual([])
    writeFileSync(path.join(dir, 'assets', 'b.js'), 'src:"https://www.PlantUML.com/plantuml/svg/"')
    expect(findPlantUmlServerRefs(dir)).toEqual([path.join(dir, 'assets', 'b.js')])
  })
})
