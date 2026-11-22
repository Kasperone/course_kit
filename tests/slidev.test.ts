import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runBuild, runDev } from '../src/commands/slidev.js'
import { runLessonNew } from '../src/commands/lesson-new.js'
import {
  deckFrontmatter,
  findForbiddenBuildRefs,
  findOutsideImports,
  findPlantUmlFiles,
  findRemoteAssetFiles,
  findWebFontFiles,
  offlineHeadmatterProblems,
} from '../src/lib/slidev.js'
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

describe('Slidev child process environment', () => {
  const keys = {
    ELEVENLABS_API_KEY: 'fake-el-key',
    ANTHROPIC_API_KEY: 'fake-an-key',
    GITHUB_TOKEN: 'fake-gh-token',
    VITE_API_KEY: 'fake-vite-key',
    SOME_UNRELATED: 'x',
  }
  const allowed = { VITE_PUBLIC_FLAG: '1', SLIDEV_FLAG: '2', DEBUG: 'none' }

  const envSeen = (ws: string): Array<Record<string, string>> =>
    readFileSync(path.join(ws, 'slidev-env.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { env: Record<string, string> }).env)

  async function withEnv<T>(fn: () => Promise<T> | T): Promise<T> {
    Object.assign(process.env, keys, allowed)
    try {
      return await fn()
    } finally {
      for (const k of [...Object.keys(keys), ...Object.keys(allowed)]) delete process.env[k]
    }
  }

  it('`course build` runs Slidev without API keys and unrelated variables', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    await withEnv(() => runBuild({ cwd: workspace }))
    const [env] = envSeen(workspace)
    expect(env!.PATH).toBeTruthy()
    for (const name of Object.keys(keys)) expect(env, name).not.toHaveProperty(name)
    expect(JSON.stringify(env)).not.toMatch(/fake-(el|an|gh|vite)-/)
    // Variables Node, Vite and Slidev read still pass.
    expect(env).toMatchObject(allowed)
  })

  it('`course dev` runs Slidev without API keys and unrelated variables', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    expect(await withEnv(() => runDev({ lesson: '01-placeholder', cwd: workspace }))).toBe(0)
    const [env] = envSeen(workspace)
    for (const name of Object.keys(keys)) expect(env, name).not.toHaveProperty(name)
    expect(env!.PATH).toBeTruthy()
  })
})

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

  it('takes the index title from the headmatter only, never from a later slide', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    const file = deck(workspace, '01-placeholder', 'en')
    const text = readFileSync(file, 'utf8').replace(/^title: .*\n/m, '')
    writeFileSync(
      file,
      `${text}\n---\ntitle: Later slide\n---\n\n\`\`\`yaml\ntitle: sample\n\`\`\`\n`,
    )
    runBuild({ cwd: workspace })
    const index = readFileSync(path.join(workspace, 'dist', 'index.html'), 'utf8')
    expect(index).not.toContain('Later slide')
    expect(index).not.toContain('sample')
    expect(index).toContain('01-placeholder')
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

  it('fails when the built output references a PlantUML server or web fonts (render-time check)', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    const file = deck(workspace, '01-placeholder', 'en')
    const head = deckFrontmatter({ title: 'x', lang: 'en' })
    // The fake build copies the deck into index.html, like a leaked default would appear.
    writeFileSync(file, `${head}\n# x\n\nSee https://www.plantuml.com/plantuml for details.\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(
      /references external servers: .*index\.html \(PlantUML server\)/,
    )
    writeFileSync(file, `${head}\n# x\n\n<!-- fonts.gstatic.com -->\n`)
    // Caught before Slidev starts (workspace Markdown) ...
    expect(() => runBuild({ cwd: workspace })).toThrow(/Web fonts from a CDN are not allowed/)
  })

  it.each([
    ['plantUmlServer', /plantUmlServer must be/],
    ['provider', /fonts\.provider must be "none"/],
    ['browserExporter', /browserExporter must be false/],
    ['favicon', /favicon must be "data:,"/],
    ['mcp', /mcp must be false/],
  ])('refuses build and dev when the headmatter lacks %s', async (key, error) => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const log = installFakeSlidev(workspace)
    const file = deck(workspace, '01-placeholder', 'en')
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace(new RegExp(`^\\s*${key}:.*\\n`, 'm'), ''))
    expect(() => runBuild({ cwd: workspace })).toThrow(error)
    expect(() => runDev({ lesson: '01-placeholder', cwd: workspace })).toThrow(error)
    expect(calls(log)).toHaveLength(0)
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

  it('finds plantuml.com and web-font CDNs in built assets only', () => {
    const dir = makeTempDir('dist')
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'assets', 'a.js'), 'const s="data:text/plain,plantuml-disabled"')
    writeFileSync(path.join(dir, 'assets', 'logo.png'), 'https://www.plantuml.com')
    expect(findForbiddenBuildRefs(dir)).toEqual([])
    writeFileSync(path.join(dir, 'assets', 'b.js'), 'src:"https://www.PlantUML.com/plantuml/svg/"')
    writeFileSync(
      path.join(dir, 'index.html'),
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito+Sans">',
    )
    writeFileSync(
      path.join(dir, 'other.html'),
      '<link rel="icon" href="https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png">',
    )
    expect(findForbiddenBuildRefs(dir)).toEqual([
      { file: path.join(dir, 'assets', 'b.js'), what: 'PlantUML server' },
      { file: path.join(dir, 'index.html'), what: 'web fonts' },
      { file: path.join(dir, 'other.html'), what: 'CDN favicon' },
    ])
  })

  it('finds web-font CDN references in workspace Markdown, Vue, CSS and HTML', () => {
    const dir = makeTempDir('fonts')
    mkdirSync(path.join(dir, 'styles'))
    writeFileSync(path.join(dir, 'ok.md'), '# no fonts here\n')
    writeFileSync(
      path.join(dir, 'styles', 'index.css'),
      "@import url('https://fonts.googleapis.com/css2?family=Inter');",
    )
    writeFileSync(path.join(dir, 'notes.txt'), 'fonts.gstatic.com')
    expect(findWebFontFiles(dir)).toEqual(['styles/index.css'])
  })
})

describe('offline headmatter policy', () => {
  const deckWith = (head: string) => `---\n${head}\n---\n\n# x\n`
  const base =
    'plantUmlServer: "data:text/plain,plantuml-disabled"\nfavicon: "data:,"\nmcp: false\n' +
    'browserExporter: false\n'

  it('accepts the generated headmatter', () => {
    expect(offlineHeadmatterProblems(deckFrontmatter({ title: 'a: b', lang: 'en' }))).toEqual([])
  })

  it('accepts block and flow forms of fonts.provider', () => {
    expect(
      offlineHeadmatterProblems(deckWith(`${base}fonts:\n  sans: x\n  provider: none`)),
    ).toEqual([])
    expect(
      offlineHeadmatterProblems(deckWith(`${base}fonts: { sans: 'x', provider: 'none' }`)),
    ).toEqual([])
  })

  it.each([
    ['no headmatter', '# x\n', /no headmatter/],
    ['google provider', deckWith(`${base}fonts:\n  provider: google`), /fonts\.provider/],
    ['fonts without provider', deckWith(`${base}fonts:\n  sans: Inter`), /fonts\.provider/],
    [
      'provider outside fonts',
      deckWith(`${base}fonts:\n  sans: Inter\nprovider: none`),
      /fonts\.provider/,
    ],
    [
      'exporter on',
      deckWith(
        `${base.replace('browserExporter: false', 'browserExporter: true')}fonts: {provider: none}`,
      ),
      /browserExporter/,
    ],
    [
      'exporter dev',
      deckWith(
        `${base.replace('browserExporter: false', 'browserExporter: dev')}fonts: {provider: none}`,
      ),
      /browserExporter/,
    ],
    ['download true', deckWith(`${base}fonts: {provider: none}\ndownload: true`), /download/],
    [
      'MCP server on (Slidev default)',
      deckWith(`${base.replace('mcp: false\n', '')}fonts: {provider: none}`),
      /mcp must be false/,
    ],
    [
      'MCP server true',
      deckWith(`${base.replace('mcp: false', 'mcp: true')}fonts: {provider: none}`),
      /mcp must be false/,
    ],
    [
      'no favicon (Slidev default: cdn.jsdelivr.net)',
      deckWith(`${base.replace('favicon: "data:,"\n', '')}fonts: {provider: none}`),
      /favicon/,
    ],
    [
      'CDN favicon',
      deckWith(`${base.replace('"data:,"', 'https://cdn.example/f.png')}fonts: {provider: none}`),
      /favicon/,
    ],
    ['download auto', deckWith(`${base}fonts: {provider: none}\ndownload: "auto"`), /download/],
    [
      'remote PlantUML server',
      deckWith(
        `${base.replace('data:text/plain,plantuml-disabled', 'https://kroki.io/plantuml')}fonts: {provider: none}`,
      ),
      /plantUmlServer/,
    ],
  ])('flags %s', (_what, text, error) => {
    expect(offlineHeadmatterProblems(text).join('\n')).toMatch(error)
  })
})

/** Markup that loads a remote resource on render (true) vs. links and local assets (false). */
const REMOTE_CASES: Array<[string, string, boolean]> = [
  ['Markdown image', '![logo](https://example.com/logo.png)\n', true],
  ['protocol-relative image', '![logo](//cdn.example/x.png)\n', true],
  ['iframe', '<iframe src="https://example.org/embed"></iframe>\n', true],
  ['multi-line img', "<img\n  class='x'\n  src='http://e.com/a.png'>\n", true],
  ['Vue :src', '<img :src="`https://e.com/${x}`">\n', true],
  ['video poster', '<video poster="https://e.com/p.jpg"></video>\n', true],
  ['script', '<script src="https://cdn.example/x.js"></script>\n', true],
  ['stylesheet link', '<link rel="stylesheet" href="https://cdn.example/x.css">\n', true],
  ['CSS url()', '<style>.a { background: url(https://e.com/bg.png) }</style>\n', true],
  ['Tweet', '<Tweet id="20" />\n', true],
  ['Youtube', '<Youtube id="abc" />\n', true],
  ['background frontmatter', '---\nlayout: cover\nbackground: https://e.com/x.jpg\n---\n', true],
  ['iframe layout url', '---\nlayout: iframe\nurl: https://example.com/page\n---\n', true],
  ['iframe-right layout url', '---\nlayout: iframe-right\nurl: //example.com/page\n---\n', true],
  ['reference-style image', '![logo][l]\n\n[l]: https://example.com/logo.png\n', true],
  ['reference definition in angle brackets', '![x][a]\n\n  [a]: <https://e.com/x.png>\n', true],
  [
    'Mermaid image node',
    '```mermaid\nflowchart LR\n  A@{ img: "https://e.com/a.png", label: "A" }\n```\n',
    true,
  ],
  ['local iframe layout url', '---\nlayout: iframe\nurl: http://localhost:3000/page\n---\n', false],
  ['local reference image', '![logo][l]\n\n[l]: ./img/logo.png\n', false],
  ['local Mermaid image node', '```mermaid\nflowchart LR\n  A@{ img: "/img/a.png" }\n```\n', false],
  ['plain link', '[GitHub](https://github.com/Kasperone/faktura)\n', false],
  ['bare URL in text', 'See https://example.com for details.\n', false],
  ['anchor tag', '<a href="https://example.com">x</a>\n', false],
  ['local image', '![a](./img/a.png) <img src="/images/a.png">\n', false],
  ['loopback image', '<img src="http://localhost:5173/a.png">\n', false],
]

/** PlantUML markup (true) vs. text that merely looks like it (false). */
const PLANTUML_CASES: Array<[string, string, boolean]> = [
  ['plantuml fence', '```plantuml\nA -> B\n```\n', true],
  ['tilde fence with a space', '~~~ plantuml\nA -> B\n~~~\n', true],
  ['indented fence', '   ```plantuml\n', true],
  [
    'Slidev component with its own server',
    '<PlantUml server="https://e.com" code="A -> B" />\n',
    true,
  ],
  ['kebab-case component', '<plant-uml :code="x" />\n', true],
  [
    'plain fence starting with "plantuml" on the next line',
    '```\nplantuml is a tool\n```\n',
    false,
  ],
  ['blank info string, then text', '```\n\nplantuml\n```\n', false],
  ['fence for another language', '```mermaid\nflowchart LR\n  A --> B\n```\n', false],
]

describe('PlantUML policy', () => {
  it.each(PLANTUML_CASES)('%s -> flagged: %s', (_what, text, flagged) => {
    const dir = makeTempDir('plantuml')
    mkdirSync(path.join(dir, 'lessons'))
    writeFileSync(path.join(dir, 'lessons', 'x.md'), text)
    expect(findPlantUmlFiles(dir)).toEqual(flagged ? ['lessons/x.md'] : [])
  })
})

describe('remote assets and slide imports', () => {
  it.each(REMOTE_CASES)('%s -> flagged: %s', (_what, text, flagged) => {
    const dir = makeTempDir('remote')
    mkdirSync(path.join(dir, 'lessons'))
    writeFileSync(path.join(dir, 'lessons', 'x.md'), text)
    expect(findRemoteAssetFiles(dir)).toEqual(flagged ? ['lessons/x.md'] : [])
  })

  it('skips context packs (they quote the target repo as data)', () => {
    const dir = makeTempDir('remote-pack')
    mkdirSync(path.join(dir, 'lessons', '01'), { recursive: true })
    writeFileSync(
      path.join(dir, 'lessons', '01', 'context-pack.md'),
      '     1|![badge](https://img.shields.io/x.svg)\n',
    )
    expect(findRemoteAssetFiles(dir)).toEqual([])
  })

  it('flags slide imports that leave the scanned files', () => {
    const dir = makeTempDir('imports')
    const lesson = path.join(dir, 'lessons', '01', 'en')
    mkdirSync(lesson, { recursive: true })
    mkdirSync(path.join(dir, 'shared'))
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    const outside = makeTempDir('imports-outside')
    symlinkSync(outside, path.join(dir, 'linked'))
    writeFileSync(
      path.join(lesson, 'slides.md'),
      [
        '---\ntheme: default\n---\n# a',
        '---\nsrc: ../../../shared/ok.md\n---',
        '---\nsrc: "../../../shared/ok.md#2-3"\n---',
        '---\nsrc: ../../../../escape.md\n---',
        '---\nsrc: /etc/slides.md\n---',
        '---\nsrc: ../../../node_modules/pkg/x.md\n---',
        '---\nsrc: ../../../linked/x.md\n---',
        '```yaml\nsrc: ../../../../in-a-code-block.md\n```',
      ].join('\n'),
    )
    expect(findOutsideImports(dir)).toEqual([
      'lessons/01/en/slides.md -> ../../../../escape.md',
      'lessons/01/en/slides.md -> ../../../linked/x.md',
      'lessons/01/en/slides.md -> ../../../node_modules/pkg/x.md',
      'lessons/01/en/slides.md -> /etc/slides.md',
    ])
  })

  it('course build refuses a deck with a remote image or an outside import', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const log = installFakeSlidev(workspace)
    const file = deck(workspace, '01-placeholder', 'en')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, `${original}\n![logo](https://example.com/logo.png)\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/Remote images.*lessons\/01-placeholder/)
    writeFileSync(file, `${original}\n---\nsrc: ../../../../elsewhere.md\n---\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/Slide imports \(src:\)/)
    writeFileSync(file, `${original}\n[a link](https://example.com) is fine\n`)
    expect(() => runBuild({ cwd: workspace })).not.toThrow()
    expect(calls(log)).toHaveLength(1)
  })
})

describe('check-deck.mjs agrees with the TypeScript policy', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const template = path.join(repoRoot, 'templates', 'workspace', 'scripts')
  const example = path.join(repoRoot, 'examples', 'faktura', 'scripts')

  it('the example workspace ships the template guard unchanged', () => {
    expect(readFileSync(path.join(example, 'check-deck.mjs'), 'utf8')).toBe(
      readFileSync(path.join(template, 'check-deck.mjs'), 'utf8'),
    )
  })

  const guardFails = (dir: string): boolean => {
    try {
      execFileSync(process.execPath, [path.join(dir, 'scripts', 'check-deck.mjs'), dir], {
        stdio: 'pipe',
      })
      return false
    } catch {
      return true
    }
  }

  const head = deckFrontmatter({ title: 't', lang: 'en' })
  const HEADMATTER_CASES: Array<[string, string]> = [
    ['generated', head],
    ['no plantUmlServer', head.replace(/^plantUmlServer:.*\n/m, '')],
    [
      'google fonts',
      head
        .replace('"provider": "none"', '"provider": "google"')
        .replace('provider: "none"', 'provider: "google"'),
    ],
    ['no favicon', head.replace(/^favicon:.*\n/m, '')],
    ['exporter on', head.replace('browserExporter: false', 'browserExporter: dev')],
    ['mcp on', head.replace('mcp: false', 'mcp: true')],
    ['download', head.replace('download: false', 'download: true')],
    ['flow fonts', head.replace(/^fonts:\n(?: {2}.*\n)+/m, 'fonts: { provider: none }\n')],
  ]

  it.each(HEADMATTER_CASES)('root deck headmatter: %s', async (_what, headmatter) => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const text = `${headmatter}\n\n# x\n`
    writeFileSync(path.join(workspace, 'slides.md'), text)
    expect(guardFails(workspace)).toBe(offlineHeadmatterProblems(text).length > 0)
  })

  it.each(PLANTUML_CASES)('PlantUML markup: %s', async (_what, body) => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    writeFileSync(path.join(workspace, 'lessons', 'extra.md'), body)
    expect(guardFails(workspace)).toBe(findPlantUmlFiles(workspace).length > 0)
  })

  it.each(REMOTE_CASES)('lesson markup: %s', async (_what, body) => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    writeFileSync(path.join(workspace, 'lessons', 'extra.md'), body)
    expect(guardFails(workspace)).toBe(findRemoteAssetFiles(workspace).length > 0)
  })
})
