import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNarrate, narrationDir } from '../src/commands/narrate.js'
import { runBuild } from '../src/commands/slidev.js'
import { pcm16ToWav, wavDuration } from '../src/lib/narration/audio.js'
import { parseManifest } from '../src/lib/narration/manifest.js'
import type { TtsProvider } from '../src/lib/narration/providers.js'
import { findExternalUrlFiles } from '../src/lib/slidev.js'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { commitAll, git, initRepo } from './helpers/git.js'

const DECK = `---
theme: default
title: "Narrated"
lang: "en"
plantUmlServer: "data:text/plain,plantuml-disabled"
fonts:
  provider: "none"
browserExporter: false
download: false
---

# One

<!--
Welcome. [click] First point.
-->

---

# Two

<!--
Only one step here.
-->
`

/** A provider that returns 0.5 s of WAV silence per call and counts calls. */
function fakeProvider(overrides: Partial<TtsProvider> = {}) {
  const calls: string[] = []
  const provider: TtsProvider = {
    id: 'fake',
    voice: 'fake-voice',
    model: 'fake-model',
    settings: { speed: 1 },
    format: 'wav',
    synthesize: (text) => {
      calls.push(text)
      return Promise.resolve(pcm16ToWav(Buffer.alloc(8000), 8000))
    },
    ...overrides,
  }
  return { provider, calls }
}

async function narratedWorkspace() {
  const fx = await makeWorkspace(undefined, { languages: ['en', 'pl'] })
  const lessonDir = path.join(fx.workspace, 'lessons', '01-placeholder')
  writeFileSync(path.join(lessonDir, 'en', 'slides.md'), DECK)
  writeFileSync(path.join(lessonDir, 'pl', 'slides.md'), DECK.replace('lang: "en"', 'lang: "pl"'))
  return fx
}

const clipsIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => /\.(wav|mp3)$/.test(f))
    .sort()

describe('course narrate', () => {
  it('writes one clip per (slide, click) step and a manifest under audio/local/<lang>/<lesson>/', async () => {
    const { workspace } = await narratedWorkspace()
    const { provider, calls } = fakeProvider()
    const result = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      makeProvider: () => provider,
    })
    expect(result.langs.map((l) => l.lang)).toEqual(['en', 'pl'])
    expect(calls).toEqual([
      'Welcome.',
      'First point.',
      'Only one step here.',
      'Welcome.',
      'First point.',
      'Only one step here.',
    ])

    const dir = narrationDir(workspace, 'en', '01-placeholder')
    expect(dir).toBe(path.join(workspace, 'audio', 'local', 'en', '01-placeholder'))
    const manifest = parseManifest(
      JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
      'm',
    )
    expect(manifest).toMatchObject({
      lesson: '01-placeholder',
      lang: 'en',
      provider: 'fake',
      voice: 'fake-voice',
      model: 'fake-model',
      format: 'wav',
    })
    expect(manifest.clips.map((c) => [c.slide, c.click, c.text])).toEqual([
      [1, 0, 'Welcome.'],
      [1, 1, 'First point.'],
      [2, 0, 'Only one step here.'],
    ])
    for (const c of manifest.clips) {
      expect(c.duration).toBeCloseTo(0.5, 3)
      expect(c.file).toBe(`s0${c.slide}-c0${c.click}-${c.key.slice(0, 12)}.wav`)
      expect(wavDuration(readFileSync(path.join(dir, c.file)))).toBeCloseTo(0.5, 3)
    }
    expect(manifest.totalDuration).toBeCloseTo(1.5, 3)
    expect(clipsIn(dir)).toHaveLength(3)
  })

  it('reuses cached clips, regenerates with --force and only changed steps after an edit', async () => {
    const { workspace } = await narratedWorkspace()
    const { provider, calls } = fakeProvider()
    const opts = {
      lessonId: '01-placeholder',
      cwd: workspace,
      lang: 'en',
      makeProvider: () => provider,
    }
    await runNarrate(opts)
    calls.length = 0

    const again = await runNarrate(opts)
    expect(calls).toEqual([])
    expect(again.langs[0]).toMatchObject({ generated: 0, reused: 3, charsSent: 0 })

    await runNarrate({ ...opts, force: true })
    expect(calls).toHaveLength(3)
    calls.length = 0

    const deck = path.join(workspace, 'lessons', '01-placeholder', 'en', 'slides.md')
    writeFileSync(deck, DECK.replace('First point.', 'First point, edited.'))
    const edited = await runNarrate(opts)
    expect(calls).toEqual(['First point, edited.'])
    expect(edited.langs[0]).toMatchObject({ generated: 1, reused: 2 })
    expect(edited.langs[0]!.stale).toHaveLength(1)
    const dir = narrationDir(workspace, 'en', '01-placeholder')
    expect(clipsIn(dir)).toHaveLength(4)

    const pruned = await runNarrate({ ...opts, prune: true })
    expect(pruned.langs[0]!.pruned).toHaveLength(1)
    expect(clipsIn(dir)).toHaveLength(3)
  })

  it('a different voice or provider gets new clips (cache key covers them)', async () => {
    const { workspace } = await narratedWorkspace()
    const a = fakeProvider()
    const b = fakeProvider({ voice: 'other-voice' })
    const opts = { lessonId: '01-placeholder', cwd: workspace, lang: 'en' }
    await runNarrate({ ...opts, makeProvider: () => a.provider })
    await runNarrate({ ...opts, makeProvider: () => b.provider })
    expect(b.calls).toHaveLength(3)
  })

  it('--dry-run synthesizes nothing and writes nothing', async () => {
    const { workspace } = await narratedWorkspace()
    const lines: string[] = []
    const result = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      dryRun: true,
      makeProvider: () => {
        throw new Error('provider must not be created in a dry run')
      },
      log: (m) => lines.push(m),
    })
    expect(result.langs.map((l) => l.clips)).toEqual([3, 3])
    expect(lines.join('\n')).toMatch(/en: 3 steps, \d+ characters/)
    expect(existsSync(narrationDir(workspace, 'en', '01-placeholder'))).toBe(false)
  })

  it('validates lesson, language and provider', async () => {
    const { workspace } = await narratedWorkspace()
    const { provider } = fakeProvider()
    const base = { cwd: workspace, makeProvider: () => provider }
    await expect(runNarrate({ ...base, lessonId: '../x' })).rejects.toThrow(/Invalid lesson id/)
    await expect(runNarrate({ ...base, lessonId: '99-nope' })).rejects.toThrow(/Unknown lesson/)
    await expect(runNarrate({ ...base, lessonId: '01-placeholder', lang: 'de' })).rejects.toThrow(
      /not in course.json/,
    )
    await expect(
      runNarrate({ ...base, lessonId: '01-placeholder', lang: '../en' }),
    ).rejects.toThrow(/Invalid language/)
    await expect(
      runNarrate({ ...base, lessonId: '01-placeholder', provider: 'say' }),
    ).rejects.toThrow(/Unknown TTS provider/)
  })

  it('never writes clips through a symlinked audio directory', async () => {
    const { workspace, root } = await narratedWorkspace()
    const outside = path.join(root, 'outside')
    mkdirSync(outside)
    mkdirSync(path.join(workspace, 'audio', 'local', 'en'), { recursive: true })
    symlinkSync(outside, path.join(workspace, 'audio', 'local', 'en', '01-placeholder'))
    const { provider } = fakeProvider()
    await expect(
      runNarrate({
        lessonId: '01-placeholder',
        cwd: workspace,
        lang: 'en',
        makeProvider: () => provider,
      }),
    ).rejects.toThrow(/symlink/)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('generated audio is never committable', () => {
  it('passes when audio/local is gitignored and nothing under it is tracked', async () => {
    const { workspace } = await narratedWorkspace()
    initRepo(workspace)
    commitAll(workspace, 'workspace')
    const { provider } = fakeProvider()
    await runNarrate({ lessonId: '01-placeholder', cwd: workspace, makeProvider: () => provider })
    // The clips and manifest are ignored: git sees nothing new.
    expect(git(workspace, ['status', '--porcelain', '--', 'audio'])).toBe('')
  })

  it('refuses when audio/local is not ignored', async () => {
    const { workspace } = await narratedWorkspace()
    const ignore = path.join(workspace, '.gitignore')
    writeFileSync(ignore, readFileSync(ignore, 'utf8').replace(/^audio\/local\/\*$/m, ''))
    initRepo(workspace)
    const { provider, calls } = fakeProvider()
    await expect(
      runNarrate({ lessonId: '01-placeholder', cwd: workspace, makeProvider: () => provider }),
    ).rejects.toThrow(/would not be ignored by git/)
    expect(calls).toEqual([])
  })

  it('refuses when a clip is already tracked', async () => {
    const { workspace } = await narratedWorkspace()
    initRepo(workspace)
    const dir = path.join(workspace, 'audio', 'local', 'en', '01-placeholder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'old.mp3'), 'x')
    git(workspace, ['add', '-f', 'audio/local/en/01-placeholder/old.mp3'])
    const { provider } = fakeProvider()
    await expect(
      runNarrate({ lessonId: '01-placeholder', cwd: workspace, makeProvider: () => provider }),
    ).rejects.toThrow(/tracked by git: audio\/local\/en\/01-placeholder\/old\.mp3/)
  })

  it('course_kit itself tracks no audio files', () => {
    const repo = path.join(__dirname, '..')
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
      .split('\0')
      .filter(
        (f) =>
          /\.(mp3|wav|ogg|opus|m4a|flac|aac)$/i.test(f) ||
          /(^|\/)audio\/local\/(?!\.gitkeep$)./.test(f),
      )
    expect(tracked).toEqual([])
  })
})

describe('course build with narration', () => {
  it('copies manifests and clips to dist/<lesson>/narration/<lang>/ for every course language', async () => {
    const { workspace } = await narratedWorkspace()
    installFakeSlidev(workspace)
    const { provider } = fakeProvider()
    await runNarrate({ lessonId: '01-placeholder', cwd: workspace, makeProvider: () => provider })
    // A stray file next to the clips is not copied.
    writeFileSync(path.join(narrationDir(workspace, 'en', '01-placeholder'), 'notes.txt'), 'x')

    const result = runBuild({ cwd: workspace, lang: 'en' })
    expect(result.narration.map((n) => `${n.lessonId}/${n.lang}:${n.clips}`)).toEqual([
      '01-placeholder/en:3',
      '01-placeholder/pl:3',
    ])
    const out = path.join(workspace, 'dist', '01-placeholder', 'narration')
    expect(readdirSync(path.join(out, 'en')).sort()).toEqual(
      [...clipsIn(narrationDir(workspace, 'en', '01-placeholder')), 'manifest.json'].sort(),
    )
    expect(existsSync(path.join(out, 'pl', 'manifest.json'))).toBe(true)

    const none = runBuild({ cwd: workspace, lang: 'en', narration: false })
    expect(none.narration).toEqual([])
  })

  it('refuses a manifest with an unsafe clip name or a symlinked clip', async () => {
    const { workspace, root } = await narratedWorkspace()
    installFakeSlidev(workspace)
    const { provider } = fakeProvider()
    await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      lang: 'en',
      makeProvider: () => provider,
    })
    const dir = narrationDir(workspace, 'en', '01-placeholder')
    const manifestFile = path.join(dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { clips: { file: string }[] }
    const original = JSON.stringify(manifest)

    manifest.clips[0]!.file = '../../../../course.json'
    writeFileSync(manifestFile, JSON.stringify(manifest))
    expect(() => runBuild({ cwd: workspace, lang: 'en' })).toThrow(/unsafe clip file name/)

    writeFileSync(manifestFile, original)
    const first = (JSON.parse(original) as { clips: { file: string }[] }).clips[0]!.file
    const secret = path.join(root, 'secret.wav')
    writeFileSync(secret, 'secret')
    rmSync(path.join(dir, first))
    symlinkSync(secret, path.join(dir, first))
    expect(() => runBuild({ cwd: workspace, lang: 'en' })).toThrow(/Narration clip missing/)
  })
})

describe('offline policy for deck code', () => {
  it('flags external URLs in Vue/TS/JS deck code and allows localhost', async () => {
    const { workspace } = await makeWorkspace()
    const comp = path.join(workspace, 'components')
    mkdirSync(comp, { recursive: true })
    writeFileSync(
      path.join(comp, 'Local.vue'),
      '<script setup>fetch("http://localhost:3030/x")</script>',
    )
    writeFileSync(path.join(comp, 'Ok.ts'), '// see ../narration/ and http://127.0.0.1:8080/\n')
    expect(findExternalUrlFiles(workspace)).toEqual([])

    writeFileSync(
      path.join(comp, 'Cdn.vue'),
      '<script setup>new Audio("https://cdn.example.com/a.mp3")</script>',
    )
    writeFileSync(path.join(comp, 'Proto.ts'), 'const u = "//tracker.example.net/p.gif"\n')
    expect(findExternalUrlFiles(workspace)).toEqual(['components/Cdn.vue', 'components/Proto.ts'])

    installFakeSlidev(workspace)
    expect(() => runBuild({ cwd: workspace })).toThrow(/must not reference external URLs/)
  })

  it('the workspace template (with the narration player) passes the policy', async () => {
    const { workspace } = await makeWorkspace()
    expect(existsSync(path.join(workspace, 'addons', 'narration', 'global-top.vue'))).toBe(true)
    expect(findExternalUrlFiles(workspace)).toEqual([])
    const guard = execFileSync(
      process.execPath,
      [path.join(workspace, 'scripts', 'check-deck.mjs'), workspace],
      {
        encoding: 'utf8',
      },
    )
    expect(guard).toBe('')
  })
})

describe('decks without notes', () => {
  it('are skipped with a warning; no provider is created and nothing is written', async () => {
    const { workspace } = await makeWorkspace()
    const warnings: string[] = []
    const result = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      makeProvider: () => {
        throw new Error('no provider needed')
      },
      warn: (m) => warnings.push(m),
    })
    expect(result.langs).toEqual([])
    expect(warnings).toHaveLength(2)
    expect(existsSync(path.join(workspace, 'audio', 'local', 'pl'))).toBe(false)
  })
})
