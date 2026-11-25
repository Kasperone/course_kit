import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNarrate } from '../src/commands/narrate.js'
import { runPin } from '../src/commands/pin.js'
import {
  hasFfmpeg,
  mp3Duration,
  mp3Format,
  pcm16ToWav,
  wavFormat,
} from '../src/lib/narration/audio.js'
import { clipKey } from '../src/lib/narration/manifest.js'
import {
  createElevenLabsProvider,
  createPiperProvider,
  type TtsProvider,
} from '../src/lib/narration/providers.js'
import {
  AUDIO_QUALITIES,
  AUDIO_QUALITY_PRESETS,
  mp3Bitrate,
  resolveAudioQuality,
  validateAudioQuality,
  type AudioQuality,
} from '../src/lib/narration/quality.js'
import { installPiperVoice, type PiperVoiceInfo } from '../src/lib/narration/voices.js'
import { parseCourseJson } from '../src/lib/workspace.js'
import { commitAll, writeFiles } from './helpers/git.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { makeTempDir } from './helpers/tmp.js'

const FAKE_PIPER = path.join(__dirname, 'helpers', 'fake-piper.mjs')
const FAKE_FFMPEG_RESAMPLING = path.join(__dirname, 'helpers', 'fake-ffmpeg-resampling.mjs')
const ffmpeg = hasFfmpeg('ffmpeg')

describe('audio quality presets', () => {
  it('defines compact, standard, high and lossless', () => {
    expect(AUDIO_QUALITIES).toEqual(['compact', 'standard', 'high', 'lossless'])
    expect(AUDIO_QUALITY_PRESETS).toMatchObject({
      compact: { format: 'mp3', kbps: 64 },
      standard: { format: 'mp3', kbps: 128 },
      high: { format: 'mp3', kbps: 192 },
      lossless: { format: 'wav' },
    })
    expect(AUDIO_QUALITY_PRESETS.lossless.kbps).toBeUndefined()
  })

  it('parses the option and rejects anything else', () => {
    for (const q of AUDIO_QUALITIES) expect(validateAudioQuality(q)).toBe(q)
    for (const bad of ['', 'HIGH', 'medium', '128k', 128, null]) {
      expect(() => validateAudioQuality(bad)).toThrow(
        /must be one of compact, standard, high, lossless/,
      )
    }
  })

  it('precedence: CLI flag, then course.json, then standard', () => {
    expect(resolveAudioQuality(undefined, undefined)).toBe('standard')
    expect(resolveAudioQuality(undefined, 'lossless')).toBe('lossless')
    expect(resolveAudioQuality('compact', 'lossless')).toBe('compact')
    expect(() => resolveAudioQuality('best', 'lossless')).toThrow(/--audio-quality must be one of/)
  })

  it('never asks for more than MP3 allows at the source sample rate', () => {
    expect(mp3Bitrate(192, 22050)).toBe(160) // MPEG-2 Layer III maximum
    expect(mp3Bitrate(128, 22050)).toBe(128)
    expect(mp3Bitrate(64, 16000)).toBe(64)
    expect(mp3Bitrate(192, 44100)).toBe(192)
  })
})

describe('course.json audioQuality', () => {
  const base = {
    schemaVersion: 1,
    targetRepo: null,
    pinnedCommit: 'a'.repeat(40),
    languages: ['en'],
  }

  it('is optional and validated', () => {
    expect(parseCourseJson(base, 'course.json').audioQuality).toBeUndefined()
    expect(parseCourseJson({ ...base, audioQuality: 'high' }, 'course.json').audioQuality).toBe(
      'high',
    )
    expect(() => parseCourseJson({ ...base, audioQuality: 'ultra' }, 'course.json')).toThrow(
      /course.json: "audioQuality" must be one of/,
    )
  })

  it('survives course pin', async () => {
    const fx = await makeWorkspace()
    const file = path.join(fx.workspace, 'course.json')
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), audioQuality: 'lossless' }),
    )
    writeFiles(fx.repoDir, { 'NEW.md': 'x\n' })
    commitAll(fx.repoDir, 'second')
    runPin({ cwd: fx.workspace })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ audioQuality: 'lossless' })
  })
})

describe('course narrate --audio-quality', () => {
  const DECK = '---\ntitle: x\n---\n\n# A\n\n<!--\nHello. [click] World.\n-->\n'

  async function workspace(audioQuality?: unknown) {
    const fx = await makeWorkspace(undefined, { languages: ['en'] })
    writeFileSync(path.join(fx.workspace, 'lessons', '01-placeholder', 'en', 'slides.md'), DECK)
    if (audioQuality !== undefined) {
      const file = path.join(fx.workspace, 'course.json')
      writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), audioQuality }),
      )
    }
    return fx.workspace
  }

  function recorder() {
    const seen: AudioQuality[] = []
    const makeProvider = (_lang: string, quality: AudioQuality): TtsProvider => {
      seen.push(quality)
      return {
        id: 'fake',
        voice: 'v',
        model: 'm',
        settings: { quality },
        format: 'wav',
        synthesize: () => Promise.resolve(pcm16ToWav(Buffer.alloc(800), 8000)),
      }
    }
    return { seen, makeProvider }
  }

  it('defaults to standard, takes course.json, and the flag overrides course.json', async () => {
    const plain = await workspace()
    const a = recorder()
    expect(
      (await runNarrate({ lessonId: '01-placeholder', cwd: plain, makeProvider: a.makeProvider }))
        .quality,
    ).toBe('standard')
    expect(a.seen).toEqual(['standard'])

    const configured = await workspace('lossless')
    const b = recorder()
    await runNarrate({ lessonId: '01-placeholder', cwd: configured, makeProvider: b.makeProvider })
    const c = recorder()
    const r = await runNarrate({
      lessonId: '01-placeholder',
      cwd: configured,
      audioQuality: 'compact',
      makeProvider: c.makeProvider,
    })
    expect(b.seen).toEqual(['lossless'])
    expect(c.seen).toEqual(['compact'])
    expect(r.quality).toBe('compact')
  })

  it('rejects an invalid flag or course.json value before synthesizing', async () => {
    const ws = await workspace()
    const a = recorder()
    await expect(
      runNarrate({
        lessonId: '01-placeholder',
        cwd: ws,
        audioQuality: 'best',
        makeProvider: a.makeProvider,
      }),
    ).rejects.toThrow(/--audio-quality must be one of/)
    const bad = await workspace('ultra')
    await expect(
      runNarrate({ lessonId: '01-placeholder', cwd: bad, makeProvider: a.makeProvider }),
    ).rejects.toThrow(/"audioQuality" must be one of/)
    expect(a.seen).toEqual([])
  })
})

/** A sha-pinned fake voice at 16 kHz, served by a fake fetch. */
async function installFakeVoice() {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const name = 'pl_PL-test-medium'
  const model = Buffer.from('fake model')
  const config = Buffer.from(JSON.stringify({ audio: { sample_rate: 16000 }, inference: {} }))
  const card = Buffer.from('card')
  const info: PiperVoiceInfo = {
    name,
    lang: 'pl',
    repoPath: 'x',
    files: {
      model: { name: `${name}.onnx`, sha256: sha(model) },
      config: { name: `${name}.onnx.json`, sha256: sha(config) },
      card: { name: 'MODEL_CARD', sha256: sha(card) },
    },
    dataset: 't',
    datasetLicense: 'CC0',
    training: 't',
  }
  const bodies: Record<string, Buffer> = {
    [`${name}.onnx`]: model,
    [`${name}.onnx.json`]: config,
    MODEL_CARD: card,
  }
  const env: NodeJS.ProcessEnv = {
    COURSE_KIT_VOICES_DIR: makeTempDir('qvoices'),
    PIPER_BIN: FAKE_PIPER,
  }
  await installPiperVoice(name, {
    env,
    registry: [info],
    fetch: (url) => Promise.resolve(new Response(new Uint8Array(bodies[url.split('/').pop()!]!))),
  })
  return { env, name }
}

describe('Piper output per preset (fake piper, 16 kHz mono voice)', () => {
  it('puts quality, format and bitrate in the cache key', async () => {
    const { env, name } = await installFakeVoice()
    const keys = new Map<string, string>()
    for (const quality of AUDIO_QUALITIES) {
      const p = createPiperProvider({ lang: 'pl', voice: name, env, quality, warn: () => {} })
      expect(p.settings).toMatchObject({ quality, sampleRate: 16000, channels: 1 })
      keys.set(
        quality,
        clipKey({
          text: 'Tekst',
          provider: p.id,
          voice: p.voice,
          model: p.model,
          settings: p.settings,
        }),
      )
      const again = createPiperProvider({ lang: 'pl', voice: name, env, quality, warn: () => {} })
      expect(
        clipKey({
          text: 'Tekst',
          provider: again.id,
          voice: again.voice,
          model: again.model,
          settings: again.settings,
        }),
      ).toBe(keys.get(quality))
    }
    expect(new Set(keys.values()).size).toBe(4)
  })

  it('lossless keeps the Piper output as WAV, byte for byte, without ffmpeg', async () => {
    const { env, name } = await installFakeVoice()
    const p = createPiperProvider({
      lang: 'pl',
      voice: name,
      env: { ...env, FFMPEG_BIN: '/nonexistent/ffmpeg' },
      quality: 'lossless',
      warn: (m) => {
        throw new Error(`unexpected warning: ${m}`)
      },
    })
    expect(p.format).toBe('wav')
    expect(p.settings).not.toHaveProperty('bitrate')
    const wav = await p.synthesize('abcd')
    // fake piper: 100 samples of 16-bit PCM per character
    expect(wav).toEqual(pcm16ToWav(Buffer.alloc(4 * 100 * 2), 16000))
    expect(wavFormat(wav)).toEqual({ sampleRate: 16000, channels: 1 })
  })

  it.skipIf(!ffmpeg)(
    'MP3 presets keep the sample rate and channels; high is capped at 160 kbit/s below 32 kHz',
    async () => {
      const { env, name } = await installFakeVoice()
      for (const [quality, kbps] of [
        ['compact', 64],
        ['standard', 128],
        ['high', 160],
      ] as const) {
        const warnings: string[] = []
        const p = createPiperProvider({
          lang: 'pl',
          voice: name,
          env,
          quality,
          warn: (m) => warnings.push(m),
        })
        expect(p.settings).toMatchObject({ format: 'mp3', bitrate: kbps })
        const mp3 = await p.synthesize('a longer sentence for the encoder')
        expect(mp3Format(mp3)).toEqual({ sampleRate: 16000, channels: 1 })
        expect(mp3Duration(mp3)).toBeGreaterThan(0.1)
        expect(warnings.join()).toMatch(quality === 'high' ? /using 160 kbit\/s/ : /^$/)
      }
    },
  )

  it('refuses MP3 output whose sample rate differs from the source (no resampling)', async () => {
    const { env, name } = await installFakeVoice()
    const p = createPiperProvider({
      lang: 'pl',
      voice: name,
      env: { ...env, FFMPEG_BIN: FAKE_FFMPEG_RESAMPLING },
      quality: 'standard',
    })
    await expect(p.synthesize('abc')).rejects.toThrow(
      /changed the audio format \(16000 Hz\/1 ch -> 44100 Hz\/1 ch\)/,
    )
  })
})

describe('ElevenLabs output per preset (mocked HTTP)', () => {
  it('requests the matching output_format and keeps the response as delivered', async () => {
    const expected: Record<AudioQuality, [string, string]> = {
      compact: ['mp3_44100_64', 'mp3'],
      standard: ['mp3_44100_128', 'mp3'],
      high: ['mp3_44100_192', 'mp3'],
      lossless: ['wav_44100', 'wav'],
    }
    const keys = new Set<string>()
    for (const quality of AUDIO_QUALITIES) {
      const urls: string[] = []
      const body = Buffer.from('audio bytes')
      const p = createElevenLabsProvider({
        voice: 'Voice123',
        apiKey: 'k',
        quality,
        fetch: (url) => {
          urls.push(url)
          return Promise.resolve(new Response(new Uint8Array(body)))
        },
      })
      const [outputFormat, format] = expected[quality]
      expect(p.format).toBe(format)
      expect(p.settings).toMatchObject({ quality, outputFormat, format })
      expect(await p.synthesize('x')).toEqual(body)
      expect(urls[0]).toMatch(new RegExp(`output_format=${outputFormat}$`))
      keys.add(
        clipKey({
          text: 'x',
          provider: p.id,
          voice: p.voice,
          model: p.model,
          settings: p.settings,
        }),
      )
    }
    expect(keys.size).toBe(4)
  })
})

describe('player and dev server accept .wav clips', () => {
  it('both file patterns allow mp3 and wav', () => {
    const addon = path.join(__dirname, '..', 'templates', 'workspace', 'addons', 'narration')
    expect(readFileSync(path.join(addon, 'global-top.vue'), 'utf8')).toContain('\\.(mp3|wav)$/')
    const plugin = readFileSync(path.join(addon, 'setup', 'vite-plugins.ts'), 'utf8')
    expect(plugin).toContain('(mp3|wav)')
    expect(plugin).toMatch(/wav: 'audio\/wav'/)
  })
})
