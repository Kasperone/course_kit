import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mp3Duration, pcm16ToWav, wavDuration } from '../src/lib/narration/audio.js'
import {
  clipFileName,
  clipKey,
  CLIP_FILE_RE,
  parseManifest,
} from '../src/lib/narration/manifest.js'
import { deckNotes, deckSteps, splitNoteSteps, toSpeech } from '../src/lib/narration/notes.js'
import { attributionMarkdown } from '../src/lib/narration/voices.js'

const HEAD = '---\ntheme: default\ntitle: "T"\n---\n'

describe('speaker notes -> steps', () => {
  it('splits slides like Slidev and takes the last comment that ends the slide', () => {
    const md = `${HEAD}
# One

<!--
Intro for slide one.
-->

---

# Two

<!-- not a note: the slide continues after it -->

Body text

---
layout: center
class: text-sm
---

# Three

\`\`\`yaml
---
key: value
---
\`\`\`

<!--
Notes three.
-->
`
    const { slides, notes } = deckNotes(md)
    expect(slides).toBe(3)
    expect(notes).toEqual(['Intro for slide one.', '', 'Notes three.'])
  })

  it('does not split on --- inside an HTML comment', () => {
    const md = `${HEAD}
# A

<!--
first
---
still slide A
-->
`
    expect(deckNotes(md).notes).toEqual(['first\n---\nstill slide A'])
  })

  it('numbers [click] and [click:n] the way Slidev does', () => {
    expect(splitNoteSteps('Intro. [click] One. [CLICK] Two. [click:2] Four.')).toEqual([
      { click: 0, text: 'Intro.' },
      { click: 1, text: 'One.' },
      { click: 2, text: 'Two.' },
      { click: 4, text: 'Four.' },
    ])
    // No intro text: the first step is click 1.
    expect(splitNoteSteps('[click] Only after the first reveal.')).toEqual([
      { click: 1, text: 'Only after the first reveal.' },
    ])
  })

  it('turns notes markup into speakable text', () => {
    expect(
      toSpeech('Use **bold**, `code`, <b>tags</b> and [a link](https://x.test).\n  Next'),
    ).toBe('Use bold, code, tags and a link. Next')
  })

  it('returns steps with 1-based slide numbers', () => {
    const md = `${HEAD}
# A
<!-- Hello. [click] World. -->

---

# B
`
    expect(deckSteps(md)).toEqual([
      { slide: 1, click: 0, text: 'Hello.' },
      { slide: 1, click: 1, text: 'World.' },
    ])
  })
})

describe('faktura lesson 01 (EN and PL)', () => {
  const deck = (lang: string) =>
    readFileSync(
      path.join(
        __dirname,
        '..',
        'examples',
        'faktura',
        'lessons',
        '01-architecture',
        lang,
        'slides.md',
      ),
      'utf8',
    )
  const vclicks = (md: string) =>
    [...md.matchAll(/<v-clicks(?: depth="(\d)")?>/g)].map((m) => m[1] ?? '1')
  const footers = (md: string) => [...md.matchAll(/abs-bl m-6/g)].length

  it('has the same (slide, click) steps in both languages, so clips line up', () => {
    const en = deckSteps(deck('en')).map((s) => `${s.slide}.${s.click}`)
    const pl = deckSteps(deck('pl')).map((s) => `${s.slide}.${s.click}`)
    expect(en.length).toBe(57)
    expect(pl).toEqual(en)
    expect(deckNotes(deck('pl')).slides).toBe(deckNotes(deck('en')).slides)
  })

  it('keeps the reveal structure, footers and verbatim diagram of the English deck', () => {
    expect(vclicks(deck('pl'))).toEqual(vclicks(deck('en')))
    expect(footers(deck('pl'))).toBe(footers(deck('en')))
    const mermaid = (md: string) => md.match(/```mermaid[\s\S]*?```/)![0]
    expect(mermaid(deck('pl'))).toBe(mermaid(deck('en')))
  })
})

describe('audio helpers', () => {
  it('wraps PCM in a WAV header and reads its duration back', () => {
    const wav = pcm16ToWav(Buffer.alloc(22050 * 2 * 3), 22050)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wavDuration(wav)).toBeCloseTo(3, 6)
    expect(() => wavDuration(Buffer.from('nope'))).toThrow(/Not a WAV/)
  })

  it('sums MP3 frame durations (MPEG-1 Layer III, 128 kbit/s, 44.1 kHz)', () => {
    // Header FF FB 90 00: MPEG-1, Layer III, no CRC, 128 kbit/s, 44100 Hz, no padding -> 417 bytes.
    const frame = Buffer.alloc(417)
    frame.set([0xff, 0xfb, 0x90, 0x00])
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5])
    const mp3 = Buffer.concat([id3, ...Array.from({ length: 50 }, () => frame)])
    expect(mp3Duration(mp3)).toBeCloseTo((50 * 1152) / 44100, 6)
    expect(() => mp3Duration(Buffer.alloc(100))).toThrow(/No MP3 frames/)
  })

  it('rejects a WAV or MP3 that is cut off, but accepts streamed WAV size placeholders', () => {
    const wav = pcm16ToWav(Buffer.alloc(22050 * 2 * 3), 22050)
    expect(() => wavDuration(wav.subarray(0, Math.floor(wav.length * 0.1)))).toThrow(/truncated/)
    expect(() => wavDuration(wav.subarray(0, wav.length - 1))).toThrow(/truncated/)
    // A WAV the API streamed has 0 or 0xFFFFFFFF in the data chunk size: the file's length counts.
    for (const placeholder of [0, 0xffffffff]) {
      const streamed = Buffer.from(wav)
      streamed.writeUInt32LE(placeholder, 40)
      expect(wavDuration(streamed)).toBeCloseTo(3, 6)
    }

    const frame = Buffer.alloc(417)
    frame.set([0xff, 0xfb, 0x90, 0x00])
    const mp3 = Buffer.concat(Array.from({ length: 10 }, () => frame))
    expect(mp3Duration(mp3)).toBeCloseTo((10 * 1152) / 44100, 6)
    // 10 whole frames plus 7 bytes of an 11th: the old walker counted the partial frame.
    expect(() => mp3Duration(Buffer.concat([mp3, frame.subarray(0, 7)]))).toThrow(/truncated/)
    expect(() => mp3Duration(mp3.subarray(0, mp3.length - 1))).toThrow(/truncated/)
  })
})

describe('cache key and manifest', () => {
  const base = {
    text: 'Hello',
    provider: 'piper',
    voice: 'v',
    model: 'm',
    settings: { a: 1, b: 2 },
  }

  it('is a sha256 over text, provider, voice, model and settings (settings order-free)', () => {
    const key = clipKey(base)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(clipKey({ ...base, settings: { b: 2, a: 1 } })).toBe(key)
    for (const change of [
      { text: 'Hello!' },
      { provider: 'elevenlabs' },
      { voice: 'w' },
      { model: 'n' },
      { settings: { a: 1, b: 3 } },
    ]) {
      expect(clipKey({ ...base, ...change })).not.toBe(key)
    }
    const name = clipFileName(3, 12, key, 'mp3')
    expect(name).toBe(`s03-c12-${key.slice(0, 12)}.mp3`)
    expect(CLIP_FILE_RE.test(name)).toBe(true)
  })

  it('rejects manifests with unsafe clip names', () => {
    const ok = {
      schemaVersion: 1,
      lesson: 'l',
      lang: 'en',
      provider: 'piper',
      voice: 'v',
      model: 'm',
      format: 'mp3',
      clips: [
        {
          slide: 1,
          click: 0,
          file: `s01-c00-${'a'.repeat(12)}.mp3`,
          duration: 1,
          key: 'a'.repeat(64),
        },
      ],
    }
    expect(parseManifest(ok, 'm').clips).toHaveLength(1)
    for (const file of ['../x.mp3', 'https://evil.test/a.mp3', 's01-c00-x.mp3', '/etc/passwd']) {
      expect(() => parseManifest({ ...ok, clips: [{ ...ok.clips[0], file }] }, 'm')).toThrow(
        /unsafe/,
      )
    }
  })
})

describe('workspace template and the faktura example stay in sync', () => {
  const repo = path.join(__dirname, '..')
  const tree = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const abs = path.join(dir, name)
      return statSync(abs).isDirectory() ? tree(abs).map((f) => `${name}/${f}`) : [name]
    })

  it('ships the same narration addon and deck guard', () => {
    const tpl = path.join(repo, 'templates', 'workspace')
    const ex = path.join(repo, 'examples', 'faktura')
    const files = tree(path.join(tpl, 'addons', 'narration'))
    expect(files.sort()).toEqual([
      'global-top.vue',
      'package.json',
      'playback.ts',
      'setup/vite-plugins.ts',
    ])
    for (const f of files) {
      expect(readFileSync(path.join(ex, 'addons', 'narration', f), 'utf8')).toBe(
        readFileSync(path.join(tpl, 'addons', 'narration', f), 'utf8'),
      )
    }
    expect(readFileSync(path.join(ex, 'scripts', 'check-deck.mjs'), 'utf8')).toBe(
      readFileSync(path.join(tpl, 'scripts', 'check-deck.mjs'), 'utf8'),
    )
    for (const dir of [tpl, ex]) {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        slidev?: { addons?: string[] }
        devDependencies?: Record<string, string>
      }
      expect(pkg.slidev?.addons).toEqual(['course-narration'])
      expect(pkg.devDependencies?.['slidev-addon-course-narration']).toBe('file:addons/narration')
    }
  })

  it('the example audio/ATTRIBUTION.md is the generated one', () => {
    expect(
      readFileSync(path.join(repo, 'examples', 'faktura', 'audio', 'ATTRIBUTION.md'), 'utf8'),
    ).toBe(attributionMarkdown())
    expect(attributionMarkdown()).toMatch(/pl_PL-darkman-medium.*CC0/)
    expect(attributionMarkdown()).toMatch(/en_US-ljspeech-medium.*Public domain/)
    expect(attributionMarkdown()).toMatch(/never commit generated audio/)
  })
})

describe('narration addon', () => {
  it('states a licence (the generated workspace otherwise licenses only lessons/)', () => {
    for (const dir of ['templates/workspace', 'examples/faktura']) {
      const pkg = JSON.parse(
        readFileSync(
          path.join(__dirname, '..', dir, 'addons', 'narration', 'package.json'),
          'utf8',
        ),
      ) as { license?: string }
      expect(pkg.license, dir).toBe('MIT')
    }
  })
})
