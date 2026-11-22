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
  localAssetRefs,
  findPlantUmlFiles,
  findRemoteAssetFiles,
  findWebFontFiles,
  offlineHeadmatterProblems,
  snippetImports,
} from '../src/lib/slidev.js'
import { sensitiveReason } from '../src/lib/context-pack/sensitive.js'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { runBounded } from './helpers/bounded.js'
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
    // Passed by the VITE_*/SLIDEV_* wildcards unless the name is recognised as a secret.
    VITE_ELEVENLABS_KEY: 'fake-vite-key-2',
    SLIDEV_SECRET_KEY: 'fake-vite-key-3',
    SLIDEV_PRIVATE_KEY: 'fake-vite-key-4',
    VITE_DB_PASS: 'fake-vite-key-5',
    VITE_TOKEN_VALUE: 'fake-vite-key-6',
    SOME_UNRELATED: 'x',
  }
  const allowed = {
    VITE_PUBLIC_FLAG: '1',
    SLIDEV_FLAG: '2',
    VITE_API_URL: 'http://localhost:8787',
    SLIDEV_KEYMAP: 'vim',
    DEBUG: 'none',
  }

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
  ['self-closing component', '<PlantUml/>\n', true],
  ['component with content', '<PlantUml>A -> B</PlantUml>\n', true],
  ['quoted pom property', '<plantuml.version>1.2024.5</plantuml.version>\n', false],
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

/** Files the snippet cases point at, relative to the workspace root. */
function writeSnippetFixtures(workspace: string): void {
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true })
    writeFileSync(path.join(workspace, rel), text)
  }
  put('snippets/code.ts', 'export const a = 1\n')
  put('snippets/diagram.puml', '@startuml\nA -> B\n@enduml\n')
  put('snippets/remote.txt', 'flowchart LR\n  A@{ img: "https://example.com/x.png" }\n')
  put('snippets/local.txt', 'flowchart LR\n  A --> B\n')
  put('snippets/key.pem', 'not a real key\n')
  put('images/logo.png', 'not a real png\n')
  put('public/hero.png', 'not a real png\n')
  put('lessons/01-placeholder/en/pic.png', 'not a real png\n')
  put('.env', 'API_KEY=dummy-value\n')
  put('course.local.json', '{"targetRepo": "/x"}\n')
  put('target-repo/a.ts', 'x\n')
  put('node_modules/pkg/x.ts', 'x\n')
  put('lessons/01-placeholder/context-pack.md', '# Context pack\n')
  put('lessons/01-placeholder/en/local.ts', 'export const b = 2\n')
  const outside = makeTempDir('snippet-outside')
  writeFileSync(path.join(outside, 'x.txt'), 'x\n')
  symlinkSync(outside, path.join(workspace, 'linked'))
}

/** Markdown placed in lessons/01-placeholder/en/extra.md (so `../../../` is the workspace root). */
const SNIPPET_CASES: Array<[string, string, boolean]> = [
  ['a snippet next to the workspace root', '<<< ../../../snippets/code.ts\n', false],
  ['with region, language and meta', '<<< ../../../snippets/code.ts#r ts {1,2}\n', false],
  ['relative to the deck', '<<< ./local.ts\n', false],
  ['`@/` is the deck directory', '<<< @/local.ts\n', false],
  ['a local Mermaid snippet', '<<< ../../../snippets/local.txt mermaid\n', false],
  ['`<<<` in the middle of a line', 'a <<< ../../../.env text\n', false],
  ['the workspace .env', '<<< ../../../.env text\n', true],
  ['the workspace .env without a language', '<<< ../../../.env\n', true],
  ['the workspace .env through `@/`', '<<< @/../../../.env text\n', true],
  ['an indented import', '  <<< ../../../.env text\n', true],
  ['an import in a block quote', '> <<< ../../../.env text\n', true],
  ['an import in a list', '- <<< ../../../.env text\n', true],
  ['an import inside a magic-move block', '````md magic-move\n<<< ../../../.env\n````\n', true],
  ['course.local.json', '<<< ../../../course.local.json json\n', true],
  ['a key file', '<<< ../../../snippets/key.pem\n', true],
  ['an absolute path', '<<< /etc/hostname text\n', true],
  ['outside the workspace', '<<< ../../../../outside.txt\n', true],
  ['into target-repo/', '<<< ../../../target-repo/a.ts\n', true],
  ['into node_modules/', '<<< ../../../node_modules/pkg/x.ts\n', true],
  ['through a symlink', '<<< ../../../linked/x.txt\n', true],
  ['a context pack', '<<< ../context-pack.md text\n', true],
  ['a PlantUML language', '<<< ../../../snippets/code.ts plantuml\n', true],
  ['a .puml file', '<<< ../../../snippets/diagram.puml\n', true],
  ['a Mermaid snippet with a remote image', '<<< ../../../snippets/remote.txt mermaid\n', true],
  ['a src: import of a context pack', '---\nsrc: ../context-pack.md\n---\n', true],
  ['a src: import of .env', '---\nsrc: ../../../.env\n---\n', true],
  ['a src: import of a deck', '---\nsrc: ./local.md\n---\n', false],
]

const ASSET_ENV = '../../../.env'
/** Local file references (images, url(), frontmatter, Vue imports) in lessons/01-placeholder/en/extra.md. */
const ASSET_CASES: Array<[string, string, boolean]> = [
  ['an image next to the deck', '![](./pic.png)\n', false],
  ['an image elsewhere in the workspace', '![alt](../../../images/logo.png "title")\n', false],
  ['an image from public/', '![](/hero.png)\n', false],
  ['an inline data: image', '![](data:image/png;base64,AAAA)\n', false],
  [
    'a plain link to .env (no asset import)',
    `[x](${ASSET_ENV})\n<a href="${ASSET_ENV}">x</a>\n`,
    false,
  ],
  ['<img> next to the deck', '<img src="./pic.png">\n', false],
  ['url() next to the deck', '<style>.x { background: url(./pic.png) }</style>\n', false],
  ['image: frontmatter next to the deck', '---\nlayout: image\nimage: ./pic.png\n---\n', false],
  ['background: a colour', '---\nbackground: "#fff"\n---\n', false],
  [
    'a Vue import of a sibling file',
    '<script setup>\nimport Foo from "./local.ts"\nimport { ref } from "vue"\n</script>\n',
    false,
  ],
  ['a Markdown image of .env', `![](${ASSET_ENV})\n`, true],
  ['with ?raw', `![](${ASSET_ENV}?raw)\n`, true],
  ['with ?url and a fragment', `![](${ASSET_ENV}?url#x)\n`, true],
  ['in angle brackets', `![alt](<${ASSET_ENV}>)\n`, true],
  ['with a title and attributes', `![a](${ASSET_ENV} "t"){width=10}\n`, true],
  ['percent-encoded', '![](..%2F..%2F..%2F.env)\n', true],
  ['through ./', `![](./../../../.env)\n`, true],
  ['with doubled slashes', '![](..//..//..//.env)\n', true],
  ['a reference-style image', `![alt][r]\n\n[r]: ${ASSET_ENV}\n`, true],
  ['<img src>', `<img src="${ASSET_ENV}">\n`, true],
  ['<img> with a Vue :src literal', `<img :src="'${ASSET_ENV}'">\n`, true],
  ['<img> over several lines', `<img\n  class="a"\n  src='${ASSET_ENV}'\n/>\n`, true],
  ['<img srcset>', `<img srcset="./pic.png 1x, ${ASSET_ENV} 2x">\n`, true],
  ['<video poster>', `<video poster="${ASSET_ENV}"></video>\n`, true],
  ['<source src>', `<video><source src="${ASSET_ENV}"></video>\n`, true],
  ['<input type=image>', `<input type="image" src="${ASSET_ENV}">\n`, true],
  ['<svg><use href>', `<svg><use href="${ASSET_ENV}#a"/></svg>\n`, true],
  ['a component :src literal', `<Foo :src="'${ASSET_ENV}'" />\n`, true],
  ['CSS url()', `<style>.x { background: url(${ASSET_ENV}) }</style>\n`, true],
  ['CSS url() with quotes', `<style>.x { background: url("${ASSET_ENV}") }</style>\n`, true],
  ['CSS @import', `<style>\n@import "${ASSET_ENV}";\n</style>\n`, true],
  ['image: frontmatter', `---\nlayout: image\nimage: ${ASSET_ENV}\n---\n`, true],
  ['background: frontmatter', `---\nbackground: "${ASSET_ENV}"\n---\n`, true],
  ['background: url() frontmatter', `---\nbackground: url(${ASSET_ENV})\n---\n`, true],
  ['an image of a magic-move block', `\`\`\`\`md magic-move\n![](${ASSET_ENV})\n\`\`\`\`\n`, true],
  ['a Vue static import', `<script setup>\nimport s from '${ASSET_ENV}?raw'\n</script>\n`, true],
  [
    'a Vue dynamic import',
    `<script setup>\nconst s = import("${ASSET_ENV}?raw")\n</script>\n`,
    true,
  ],
  [
    'new URL()',
    `<script setup>\nconst u = new URL('${ASSET_ENV}', import.meta.url)\n</script>\n`,
    true,
  ],
  ['a key file', '![](../../../snippets/key.pem)\n', true],
  ['course.local.json', '![](../../../course.local.json)\n', true],
  ['outside the workspace (Markdown)', '![](../../../../outside.png)\n', true],
  [
    'outside the workspace (url())',
    '<style>.x { background: url(../../../../outside.png) }</style>\n',
    true,
  ],
  [
    'outside the workspace (image:)',
    '---\nlayout: image\nimage: ../../../../outside.png\n---\n',
    true,
  ],
  ['an absolute path (Markdown)', '![](/etc/hostname)\n', true],
  ['an absolute path (url())', '<style>.x { background: url(/etc/hostname) }</style>\n', true],
  ['an absolute path (image:)', '---\nlayout: image\nimage: /etc/hostname\n---\n', true],
  ['a file: URL', '![](file:///etc/hostname)\n', true],
  ['/@fs/ path', '![](/@fs/etc/hostname)\n', true],
  ['.env relative to the root', '![](/.env)\n', true],
  ['.env through public/', '![](/../.env)\n', true],
  ['through a symlink (Markdown)', '![](../../../linked/x.txt)\n', true],
  [
    'through a symlink (url())',
    '<style>.x { background: url(../../../linked/x.txt) }</style>\n',
    true,
  ],
  ['through a symlink (image:)', '---\nlayout: image\nimage: ../../../linked/x.txt\n---\n', true],
  ['into target-repo/', '![](../../../target-repo/a.ts)\n', true],
  ['into node_modules/', '![](../../../node_modules/pkg/x.ts)\n', true],
  ['a context pack', '![](../context-pack.md)\n', true],
]

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

  it('parses Slidev snippet imports like Slidev does', () => {
    expect(snippetImports('<<< ../a.ts#region ts {1,2}\n')).toEqual([
      { path: '../a.ts', lang: 'ts' },
    ])
    expect(snippetImports('<<< @/b.vue\n<<< ./c.json json')).toEqual([
      { path: '@/b.vue', lang: 'vue' },
      { path: './c.json', lang: 'json' },
    ])
    expect(snippetImports('text <<< ../a.ts\n<<<\n')).toEqual([])
  })

  it.each(SNIPPET_CASES)('%s -> flagged: %s', (_what, body, flagged) => {
    const dir = makeTempDir('snippets')
    writeSnippetFixtures(dir)
    const deckDir = path.join(dir, 'lessons', '01-placeholder', 'en')
    writeFileSync(path.join(deckDir, 'extra.md'), body)
    writeFileSync(path.join(deckDir, 'local.md'), '# local\n')
    const found = findOutsideImports(dir)
    expect(found.length > 0, found.join('\n')).toBe(flagged)
  })

  it.each(ASSET_CASES)('asset paths: %s -> flagged: %s', (_what, body, flagged) => {
    const dir = makeTempDir('assets')
    writeSnippetFixtures(dir)
    const deckDir = path.join(dir, 'lessons', '01-placeholder', 'en')
    writeFileSync(path.join(deckDir, 'extra.md'), body)
    const found = findOutsideImports(dir)
    expect(found.length > 0, found.join('\n')).toBe(flagged)
  })

  it('checks CSS, HTML and Vue files too, relative to the file', () => {
    const dir = makeTempDir('assets-files')
    writeSnippetFixtures(dir)
    const deckDir = path.join(dir, 'lessons', '01-placeholder', 'en')
    writeFileSync(path.join(deckDir, 'a.css'), '.x { background: url(../../../.env) }\n')
    writeFileSync(path.join(deckDir, 'b.html'), '<img src="../../../.env">\n')
    writeFileSync(path.join(deckDir, 'c.vue'), '<template><img src="../../../.env" /></template>\n')
    writeFileSync(path.join(deckDir, 'ok.css'), '.x { background: url(./pic.png) }\n')
    expect(findOutsideImports(dir)).toEqual([
      'lessons/01-placeholder/en/a.css -> asset ../../../.env',
      'lessons/01-placeholder/en/b.html -> asset ../../../.env',
      'lessons/01-placeholder/en/c.vue -> asset ../../../.env',
    ])
  })

  it('lists local asset references like Slidev resolves them', () => {
    expect(
      localAssetRefs(
        [
          '![a](./a.png "t") ![b](<./b c.png>) ![](https://x.test/r.png)',
          '<img src="./d.png" :src="\'./e.png\'"> <a href="./f.png">x</a> <link href="./g.css">',
          '.x { background: url("./h.png"); } @import "./i.css";',
          'image: ./j.png',
          'import k from "./k.ts"; import l from "vue"; const m = import("./m.ts")',
        ].join('\n'),
      ),
    ).toEqual([
      './a.png',
      './b c.png',
      'https://x.test/r.png',
      './h.png',
      './i.css',
      './j.png',
      './k.ts',
      './m.ts',
      './d.png',
      './e.png',
      './g.css',
    ])
  })

  it('names the import that was refused', () => {
    const dir = makeTempDir('snippets-names')
    writeSnippetFixtures(dir)
    writeFileSync(
      path.join(dir, 'lessons', '01-placeholder', 'en', 'extra.md'),
      '<<< ../../../.env text\n',
    )
    expect(findOutsideImports(dir)).toEqual([
      'lessons/01-placeholder/en/extra.md -> <<< ../../../.env',
    ])
  })

  it('skips context packs for the PlantUML and web-font scans: they quote the target repo', () => {
    const dir = makeTempDir('pack-scans')
    mkdirSync(path.join(dir, 'lessons', '01'), { recursive: true })
    const pack = path.join(dir, 'lessons', '01', 'context-pack.md')
    writeFileSync(
      pack,
      [
        '     1|<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">',
        '     2|<plantuml.version>1.2024</plantuml.version>',
        '     3|<PlantUml code="A -> B" />',
        '     4|```plantuml',
      ].join('\n'),
    )
    expect(findWebFontFiles(dir)).toEqual([])
    expect(findPlantUmlFiles(dir)).toEqual([])
    // Other Markdown files are still scanned.
    writeFileSync(path.join(dir, 'lessons', '01', 'notes.md'), '<PlantUml code="x" />\n')
    expect(findPlantUmlFiles(dir)).toEqual(['lessons/01/notes.md'])
  })

  it('`course build` works with a pack that quotes web fonts and PlantUML, and refuses to import it', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    writeFileSync(
      path.join(workspace, 'lessons', '01-placeholder', 'context-pack.md'),
      '     1|<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">\n' +
        '     2|<plantuml.version>1.2024</plantuml.version>\n',
    )
    expect(() => runBuild({ cwd: workspace })).not.toThrow()
    const file = deck(workspace, '01-placeholder', 'en')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, `${original}\n---\nsrc: ../context-pack.md\n---\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/Slide imports.*context-pack\.md/s)
    writeFileSync(file, `${original}\n<<< ../context-pack.md text\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/Slide imports.*<<< \.\.\/context-pack\.md/s)
  })

  it('`course build` refuses a snippet import of the workspace .env before Slidev starts', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const log = installFakeSlidev(workspace)
    writeFileSync(path.join(workspace, '.env'), 'ELEVENLABS_API_KEY=dummy-key-value\n')
    const file = deck(workspace, '01-placeholder', 'en')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n<<< ../../../.env text\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(
      /Slide imports.*<<< \.\.\/\.\.\/\.\.\/\.env/s,
    )
    expect(calls(log)).toHaveLength(0)
    expect(existsSync(path.join(workspace, 'dist'))).toBe(false)
  })

  it('`course build` refuses an image of the workspace .env before Slidev starts', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const log = installFakeSlidev(workspace)
    writeFileSync(path.join(workspace, '.env'), 'ELEVENLABS_API_KEY=dummy-key-value\n')
    const file = deck(workspace, '01-placeholder', 'en')
    const original = readFileSync(file, 'utf8')
    for (const body of [
      '![](../../../.env?raw)',
      '<style>.x { background: url(../../../.env) }</style>',
    ]) {
      writeFileSync(file, `${original}\n${body}\n`)
      expect(() => runBuild({ cwd: workspace })).toThrow(/asset path.*\.env/s)
    }
    expect(calls(log)).toHaveLength(0)
    expect(existsSync(path.join(workspace, 'dist'))).toBe(false)
  })

  it('stops a Slidev build that does not finish', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    writeFileSync(path.join(workspace, 'slidev-hang'), '')
    // In a child process under an outer limit: without the timeout this fails instead of freezing.
    const run = await runBounded('slidev-build', [workspace, '400'], 20_000)
    expect(run.hung, run.stdout + run.stderr).toBe(false)
    expect(run.stdout).toMatch(/RESULT: Slidev did not finish within \d+ s and was stopped/)
  }, 40_000)

  it('negative control: the same hanging build never finishes without the timeout', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    writeFileSync(path.join(workspace, 'slidev-hang'), '')
    const run = await runBounded('slidev-build', [workspace, '0'], 6_000)
    expect(run.hung, 'a timeout-less build of the hanging stand-in must hang').toBe(true)
    expect(run.stdout).not.toContain('RESULT:')
  }, 30_000)

  it('course build refuses a deck with a remote image or an outside import', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const log = installFakeSlidev(workspace)
    const file = deck(workspace, '01-placeholder', 'en')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, `${original}\n![logo](https://example.com/logo.png)\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/Remote images.*lessons\/01-placeholder/)
    writeFileSync(file, `${original}\n---\nsrc: ../../../../elsewhere.md\n---\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/Slide imports \(src: and <<< snippets\)/)
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

  it.each(SNIPPET_CASES)('slide imports: %s', async (_what, body) => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    writeSnippetFixtures(workspace)
    const deckDir = path.join(workspace, 'lessons', '01-placeholder', 'en')
    writeFileSync(path.join(deckDir, 'extra.md'), body)
    writeFileSync(path.join(deckDir, 'local.md'), '# local\n')
    expect(guardFails(workspace)).toBe(findOutsideImports(workspace).length > 0)
  })

  it.each(ASSET_CASES)('asset paths: %s', async (_what, body) => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    writeSnippetFixtures(workspace)
    const deckDir = path.join(workspace, 'lessons', '01-placeholder', 'en')
    writeFileSync(path.join(deckDir, 'extra.md'), body)
    expect(guardFails(workspace)).toBe(findOutsideImports(workspace).length > 0)
  })

  it('skips context packs for the PlantUML and web-font checks, and refuses to import one', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const pack = path.join(workspace, 'lessons', '01-placeholder', 'context-pack.md')
    writeFileSync(
      pack,
      '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">\n<PlantUml code="x" />\n',
    )
    expect(guardFails(workspace)).toBe(false)
    const extra = path.join(workspace, 'lessons', '01-placeholder', 'en', 'extra.md')
    writeFileSync(extra, '---\nsrc: ../context-pack.md\n---\n')
    expect(guardFails(workspace)).toBe(true)
  })

  it('refuses the same secret-looking files as the context-pack denylist', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    const denied = [
      '.env',
      'src/.env',
      'config/.env.production',
      'a/prod.env',
      'a/.envrc',
      'src/id_ed25519',
      'home/.ssh/id_rsa.pub',
      'certs/server.pem',
      'deploy/tls.KEY',
      'keys/deploy.ppk',
      'src/main/resources/keystore.jks',
      '.npmrc',
      'a/.git-credentials',
      '.docker/config.json',
      '.kube/config',
      'deploy/kubeconfig',
      'ci/prod.kubeconfig',
      'gcp/credentials.json',
      'gcp/my-credentials.json',
      'gcp/prod-credentials.yaml',
      'config/secrets.yml',
      'a/secret.txt',
      'infra/secrets/db.txt',
      'infra/terraform.tfstate',
      'infra/prod.tfvars',
      'x/service-account-prod.json',
      'src/main/resources/application-prod.yml',
    ]
    const allowed = [
      '.env.example',
      'backend/.env.sample',
      'src/main/resources/application.yml',
      'src/main/java/com/example/KeyService.java',
      'docs/environment.md',
      'docs/kubeconfig-howto.md',
      'README.md',
    ]
    const deckDir = path.join(workspace, 'lessons', '01-placeholder', 'en')
    for (const file of [...denied, ...allowed]) {
      mkdirSync(path.dirname(path.join(workspace, 'dl', file)), { recursive: true })
      writeFileSync(path.join(workspace, 'dl', file), 'x\n')
      writeFileSync(path.join(deckDir, 'extra.md'), `<<< ../../../dl/${file} text\n`)
      const expected = sensitiveReason(file) !== null
      expect(expected, `${file} in the context-pack denylist`).toBe(denied.includes(file))
      expect(guardFails(workspace), file).toBe(expected)
      expect(findOutsideImports(workspace).length > 0, file).toBe(expected)
    }
  })
})
