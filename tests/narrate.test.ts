import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runNarrate, narrationDir } from '../src/commands/narrate.js'
import { runBuild } from '../src/commands/slidev.js'
import { pcm16ToWav, wavDuration } from '../src/lib/narration/audio.js'
import { parseManifest } from '../src/lib/narration/manifest.js'
import type { TtsProvider } from '../src/lib/narration/providers.js'
import { findExternalUrlFiles } from '../src/lib/slidev.js'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { commitAll, git, initRepo } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

const DECK = `---
theme: default
title: "Narrated"
lang: "en"
plantUmlServer: "data:text/plain,plantuml-disabled"
fonts:
  provider: "none"
favicon: "data:,"
browserExporter: false
download: false
mcp: false
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

describe('the clip cache', () => {
  const html = () => Promise.resolve(Buffer.from('<html>Please log in to the Wi-Fi</html>'))

  it('does not cache a response that is not audio, and names the clip in the error', async () => {
    const { workspace } = await narratedWorkspace()
    const bad = fakeProvider({ synthesize: html })
    await expect(
      runNarrate({
        lessonId: '01-placeholder',
        cwd: workspace,
        lang: 'en',
        makeProvider: () => bad.provider,
      }),
    ).rejects.toThrow(
      /response for en 1\.0 is not valid wav audio .*nothing was cached for s01-c00-/,
    )
    const dir = narrationDir(workspace, 'en', '01-placeholder')
    expect(clipsIn(dir)).toEqual([])

    // The next run with a working provider is not stuck on the bad response.
    const good = fakeProvider()
    const result = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      lang: 'en',
      makeProvider: () => good.provider,
    })
    expect(result.langs[0]).toMatchObject({ generated: 3, reused: 0 })
  })

  it('regenerates a cached clip that is not valid audio instead of failing on it forever', async () => {
    const { workspace } = await narratedWorkspace()
    const first = fakeProvider()
    await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      lang: 'en',
      makeProvider: () => first.provider,
    })
    const dir = narrationDir(workspace, 'en', '01-placeholder')
    const [clip] = clipsIn(dir)
    writeFileSync(path.join(dir, clip!), '<html>truncated</html>')
    const logs: string[] = []
    const second = fakeProvider()
    const result = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      lang: 'en',
      makeProvider: () => second.provider,
      log: (m) => logs.push(m),
    })
    expect(result.langs[0]).toMatchObject({ generated: 1, reused: 2 })
    expect(logs.join('\n')).toMatch(new RegExp(`cached clip ${clip!} is not valid wav audio`))
    expect(wavDuration(readFileSync(path.join(dir, clip!)))).toBeGreaterThan(0)
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

  it('refuses a narrower ignore rule that covers MP3 clips but not WAV clips or the manifest', async () => {
    const { workspace } = await narratedWorkspace()
    const ignore = path.join(workspace, '.gitignore')
    writeFileSync(
      ignore,
      readFileSync(ignore, 'utf8').replace(/^audio\/local\/\*$/m, 'audio/local/**/*.mp3'),
    )
    initRepo(workspace)
    const { provider, calls } = fakeProvider()
    await expect(
      runNarrate({ lessonId: '01-placeholder', cwd: workspace, makeProvider: () => provider }),
    ).rejects.toThrow(/\.wav would not be ignored by git/)
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

  describe('when git cannot answer (the guard must not turn itself off)', () => {
    /** A `git` first on PATH: runs `script` for matching calls, otherwise the real git. */
    async function withGit(script: string, run: () => Promise<void>): Promise<void> {
      const bin = makeTempDir('narrate-git-wrapper')
      writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\n${script}\nPATH="\${PATH#*:}" exec git "$@"\n`,
      )
      chmodSync(path.join(bin, 'git'), 0o755)
      const saved = process.env.PATH
      process.env.PATH = `${bin}${path.delimiter}${saved}`
      try {
        await run()
      } finally {
        process.env.PATH = saved
      }
    }
    /** A fresh module: the git version check is cached per process once it has passed. */
    async function freshNarrate() {
      vi.resetModules()
      return (await import('../src/commands/narrate.js')).runNarrate
    }
    async function unignoredWorkspace() {
      const { workspace } = await narratedWorkspace()
      const ignore = path.join(workspace, '.gitignore')
      writeFileSync(ignore, readFileSync(ignore, 'utf8').replace(/^audio\/local\/\*$/m, ''))
      initRepo(workspace)
      return workspace
    }

    it('git older than 2.38: refuses with the upgrade message instead of skipping the guard', async () => {
      const workspace = await unignoredWorkspace()
      const runNarrateFresh = await freshNarrate()
      const { provider, calls } = fakeProvider()
      await withGit('[ "$1" = --version ] && { echo "git version 2.34.1"; exit 0; }', async () => {
        await expect(
          runNarrateFresh({
            lessonId: '01-placeholder',
            cwd: workspace,
            makeProvider: () => provider,
          }),
        ).rejects.toThrow(/needs git >= 2\.38/)
      })
      expect(calls).toEqual([])
      expect(existsSync(path.join(workspace, 'audio', 'local', 'en'))).toBe(false)
    })

    it.each([
      [
        'rev-parse fails (dubious ownership)',
        'rev-parse',
        'detected dubious ownership in repository',
      ],
      ['check-ignore fails', 'check-ignore', 'fatal: unable to read the index'],
      ['ls-files fails', 'ls-files', 'fatal: index file corrupt'],
    ])('%s: refuses instead of passing', async (_what, verb, message) => {
      // An ignored workspace: the verbs before the failing one succeed, the guard has to ask git.
      const { workspace } = await narratedWorkspace()
      initRepo(workspace)
      const runNarrateFresh = await freshNarrate()
      const { provider, calls } = fakeProvider()
      await withGit(
        `for a in "$@"; do [ "$a" = ${verb} ] && { echo "${message}" >&2; exit 128; }; done`,
        async () => {
          await expect(
            runNarrateFresh({
              lessonId: '01-placeholder',
              cwd: workspace,
              makeProvider: () => provider,
            }),
          ).rejects.toThrow(
            new RegExp(`Could not check .*${message.split(' ').slice(-2).join(' ')}`),
          )
        },
      )
      expect(calls).toEqual([])
    })

    it('not a git repository, or no git at all: nothing to commit to, the run goes on', async () => {
      const { workspace } = await narratedWorkspace()
      const runNarrateFresh = await freshNarrate()
      const { provider } = fakeProvider()
      await withGit(
        'for a in "$@"; do [ "$a" = rev-parse ] && { echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128; }; done',
        async () => {
          await runNarrateFresh({
            lessonId: '01-placeholder',
            cwd: workspace,
            makeProvider: () => provider,
          })
        },
      )
      expect(existsSync(path.join(workspace, 'audio', 'local', 'en', '01-placeholder'))).toBe(true)

      const second = await narratedWorkspace()
      const runAgain = await freshNarrate()
      const saved = process.env.PATH
      process.env.PATH = makeTempDir('narrate-no-git')
      try {
        await runAgain({
          lessonId: '01-placeholder',
          cwd: second.workspace,
          makeProvider: () => fakeProvider().provider,
        })
      } finally {
        process.env.PATH = saved
      }
    })
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

describe('course narrate: all providers are built before the first synthesis', () => {
  it('--lang all with a voice that fits only one language fails before any clip is synthesized', async () => {
    const { workspace } = await narratedWorkspace()
    const { provider, calls } = fakeProvider()
    const built: string[] = []
    await expect(
      runNarrate({
        lessonId: '01-placeholder',
        cwd: workspace,
        makeProvider: (lang) => {
          built.push(lang)
          // What createPiperProvider does for `--voice pl_PL-darkman-medium` on the English deck.
          if (lang === 'en') throw new Error('Voice pl_PL-darkman-medium is Polish, not en')
          return provider
        },
      }),
    ).rejects.toThrow(/is Polish, not en/)
    expect(built).toEqual(['en'])
    expect(calls).toEqual([])
    expect(existsSync(path.join(workspace, 'audio', 'local', 'pl'))).toBe(false)
    // The second language failing is caught as early as the first.
    await expect(
      runNarrate({
        lessonId: '01-placeholder',
        cwd: workspace,
        makeProvider: (lang) => {
          if (lang === 'pl') throw new Error('no pl voice installed')
          return provider
        },
      }),
    ).rejects.toThrow(/no pl voice/)
    expect(calls).toEqual([])
    expect(existsSync(path.join(workspace, 'audio', 'local', 'en'))).toBe(false)
  })
})

describe('course narrate: interrupted and truncated clips', () => {
  it('regenerates a cached clip that was cut short (an interrupted run) instead of reusing it', async () => {
    const { workspace } = await narratedWorkspace()
    const { provider, calls } = fakeProvider()
    const run = () =>
      runNarrate({
        lessonId: '01-placeholder',
        lang: 'en',
        cwd: workspace,
        makeProvider: () => provider,
        log: () => {},
      })
    await run()
    const dir = narrationDir(workspace, 'en', '01-placeholder')
    const [first] = clipsIn(dir)
    const file = path.join(dir, first!)
    const whole = readFileSync(file)
    // What a Ctrl-C in the middle of a write used to leave under the real name: a header that
    // declares more audio than the file holds.
    writeFileSync(file, whole.subarray(0, Math.floor(whole.length * 0.1)))
    calls.length = 0
    const result = await run()
    expect(calls).toHaveLength(1)
    expect(result.langs[0]).toMatchObject({ generated: 1, reused: 2 })
    expect(readFileSync(file).equals(whole)).toBe(true)
  })

  it('writes through <file>.part: none is left behind, a stale one is dropped, a failed rename cleans up', async () => {
    const { workspace } = await narratedWorkspace()
    const { provider } = fakeProvider()
    const run = () =>
      runNarrate({
        lessonId: '01-placeholder',
        lang: 'en',
        cwd: workspace,
        makeProvider: () => provider,
        log: () => {},
      })
    const dir = narrationDir(workspace, 'en', '01-placeholder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 's01-c00-deadbeefdead.wav.part'), 'half a clip')
    await run()
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])

    // The rename cannot replace a directory: the run fails and its .part file is removed.
    const [first] = clipsIn(dir)
    rmSync(path.join(dir, first!))
    mkdirSync(path.join(dir, first!))
    writeFileSync(path.join(dir, first!, 'x'), 'x')
    await expect(run()).rejects.toThrow()
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
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

  it.each([
    ['a component in a nested scripts/ directory', 'components/scripts/Tracker.vue', true],
    ['a component in a nested audio/ directory', 'components/audio/Player.vue', true],
    ['a TSX component', 'components/Widget.tsx', true],
    ['a JSX component', 'components/Widget.jsx', true],
    ['a layout', 'layouts/Wide.vue', true],
    ['the top-level scripts/ helpers (not deck code)', 'scripts/helper.mjs', false],
    ['the top-level audio/ directory', 'audio/local/x.js', false],
    ['node_modules at any depth', 'components/node_modules/x/index.js', false],
  ])('scans %s', async (_what, file, flagged) => {
    const { workspace } = await makeWorkspace()
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true })
    writeFileSync(path.join(workspace, file), 'export const u = "https://evil.example.com/t"\n')
    expect(findExternalUrlFiles(workspace)).toEqual(flagged ? [file] : [])
    // The workspace guard script (npm run dev/build) applies the same rules.
    let failed = false
    try {
      execFileSync(
        process.execPath,
        [path.join(workspace, 'scripts', 'check-deck.mjs'), workspace],
        {
          stdio: 'pipe',
        },
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(flagged)
  })

  it.each([
    ['//localhost.evil.com/x.js', true],
    ['//127.0.0.1.nip.io/x', true],
    ['//evil.example.com/x.js', true],
    ['//localhost/x.js', false],
    ['//localhost:3030/x.js', false],
    ['//127.0.0.1/x.js', false],
    ['//127.0.0.1:8080/x.js', false],
  ])('protocol-relative %s -> flagged: %s', async (url, flagged) => {
    const { workspace } = await makeWorkspace()
    mkdirSync(path.join(workspace, 'components'), { recursive: true })
    writeFileSync(path.join(workspace, 'components', 'P.ts'), `const u = "${url}"\n`)
    expect(findExternalUrlFiles(workspace).length > 0).toBe(flagged)
    let failed = false
    try {
      execFileSync(
        process.execPath,
        [path.join(workspace, 'scripts', 'check-deck.mjs'), workspace],
        {
          stdio: 'pipe',
        },
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(flagged)
  })

  it.each([
    [
      'a <script setup> block in a slide (the beacon from the review)',
      'lessons/extra.md',
      "# s\n\n<script setup>fetch('https://tracker.example.com/beacon')</script>\n",
      true,
    ],
    [
      'a multi-line <script setup lang="ts"> block',
      'lessons/extra.md',
      '# s\n\n<script setup lang="ts">\nconst u = "https://cdn.example.com/a.mp3"\nnew Audio(u)\n</script>\n',
      true,
    ],
    [
      'a protocol-relative URL in a slide script',
      'lessons/extra.md',
      '<script>const u = "//tracker.example.net/p.gif"</script>\n',
      true,
    ],
    [
      'a <script> example in a code fence',
      'lessons/extra.md',
      '```html\n<script>fetch("https://tracker.example.com/beacon")</script>\n```\n',
      false,
    ],
    [
      'a <script> example in a tilde fence',
      'lessons/extra.md',
      '~~~vue\n<script setup>fetch("https://tracker.example.com/beacon")</script>\n~~~\n',
      false,
    ],
    [
      'a slide script that only uses localhost',
      'lessons/extra.md',
      '<script setup>fetch("http://localhost:3030/x")</script>\n',
      false,
    ],
    [
      'a plain link in prose (makes no request until clicked)',
      'lessons/extra.md',
      'See [the docs](https://example.com/docs) and https://example.org/x.\n',
      false,
    ],
    [
      'a script in a context pack (data quoted from the target)',
      'lessons/01-placeholder/context-pack.md',
      '<script>fetch("https://tracker.example.com/beacon")</script>\n',
      false,
    ],
    [
      'an inline SVG icon with its xmlns (a name, not a request)',
      'components/Icon.vue',
      '<template><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg></template>\n',
      false,
    ],
    [
      'createElementNS with the SVG namespace',
      'components/Draw.ts',
      "export const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')\n",
      false,
    ],
    [
      'an SVG with xmlns that also loads a remote image',
      'components/Icon.vue',
      '<template><svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example.com/x.png"/></svg></template>\n',
      true,
    ],
    [
      'another w3.org URL (only the namespace identifiers are exempt)',
      'components/Draw.ts',
      "export const u = 'https://www.w3.org/evil.js'\n",
      true,
    ],
  ])('scans slide scripts and ignores XML namespaces: %s', async (_what, file, body, flagged) => {
    const { workspace } = await makeWorkspace()
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true })
    writeFileSync(path.join(workspace, file), body)
    expect(findExternalUrlFiles(workspace).length > 0).toBe(flagged)
    let failed = false
    try {
      execFileSync(
        process.execPath,
        [path.join(workspace, 'scripts', 'check-deck.mjs'), workspace],
        { stdio: 'pipe' },
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(flagged)
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
