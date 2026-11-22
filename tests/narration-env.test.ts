import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasFfmpeg, pcm16ToWav, wavToMp3 } from '../src/lib/narration/audio.js'
import { ffmpegEnv, piperEnv } from '../src/lib/narration/env.js'
import { createPiperProvider } from '../src/lib/narration/providers.js'
import { installPiperVoice } from '../src/lib/narration/voices.js'
import { fakeVoice } from './helpers/fake-voice.js'
import { makeTempDir } from './helpers/tmp.js'

const FAKE_PIPER = path.join(__dirname, 'helpers', 'fake-piper.mjs')

// Fake secrets, assembled at runtime so the repo never contains key-shaped strings.
const V = ['fake', 'value', '123456'].join('-')
const SECRETS: Record<string, string> = {
  ELEVENLABS_API_KEY: `${V}-el`,
  ANTHROPIC_API_KEY: `${V}-an`,
  ANTHROPIC_AUTH_TOKEN: `${V}-at`,
  GITHUB_TOKEN: `${V}-gh`,
  NPM_TOKEN: `${V}-npm`,
  AWS_SECRET_ACCESS_KEY: `${V}-aws`,
  DB_PASSWORD: `${V}-db`,
  PIPER_API_TOKEN: `${V}-pt`, // a PIPER_* name that is still a credential
}

/** Run `fn` with the fake secrets (and `extra` variables) set in process.env. */
async function withEnv<T>(extra: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const all = { ...SECRETS, ...extra }
  Object.assign(process.env, all)
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(all)) delete process.env[k]
  }
}

function expectNoSecrets(env: NodeJS.ProcessEnv, what: string) {
  for (const name of Object.keys(env)) {
    expect(name, `${what}: ${name}`).not.toMatch(/(?:API_?KEY|TOKEN|SECRET|PASSWORD)$/i)
  }
  const text = JSON.stringify(env)
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(text, `${what}: ${name}`).not.toContain(value)
  }
  expect(env.PATH, `${what}: PATH`).toBeTruthy()
}

const logLines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> })

describe('piperEnv / ffmpegEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'pl_PL.UTF-8',
    TMPDIR: '/tmp',
    PIPER_BIN: '/venv/bin/piper',
    ESPEAK_DATA_PATH: '/venv/espeak-ng-data',
    LD_LIBRARY_PATH: '/venv/lib',
    OMP_NUM_THREADS: '2',
    FFMPEG_BIN: '/usr/bin/ffmpeg',
    ...SECRETS,
    UNRELATED: 'x',
  }

  it('piper keeps what it needs to run and nothing credential-like', () => {
    const env = piperEnv(source)
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'pl_PL.UTF-8',
      TMPDIR: '/tmp',
      PIPER_BIN: '/venv/bin/piper',
      ESPEAK_DATA_PATH: '/venv/espeak-ng-data',
      LD_LIBRARY_PATH: '/venv/lib',
      OMP_NUM_THREADS: '2',
    })
    expect(env).not.toHaveProperty('UNRELATED')
    expect(env).not.toHaveProperty('PIPER_API_TOKEN')
    expectNoSecrets(env, 'piperEnv')
  })

  it('ffmpeg gets the base allowlist only', () => {
    const env = ffmpegEnv(source)
    expect(Object.keys(env).sort()).toEqual(
      ['GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH', 'TMPDIR'].sort(),
    )
  })
})

describe('Piper and ffmpeg children never see API keys', () => {
  async function installed() {
    const env: NodeJS.ProcessEnv = {
      COURSE_KIT_VOICES_DIR: makeTempDir('voices'),
      PIPER_BIN: FAKE_PIPER,
    }
    const v = fakeVoice('pl_PL-test-medium')
    await installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] })
    return env
  }

  /** A recording ffmpeg: logs argv and environment, reads stdin, produces no audio. */
  function fakeFfmpeg(log: string): string {
    const dir = makeTempDir('fake-ffmpeg')
    const bin = path.join(dir, 'ffmpeg')
    writeFileSync(
      bin,
      `#!${process.execPath}\n` +
        `const { appendFileSync, readFileSync } = require('node:fs')\n` +
        `if (!process.argv.includes('-version')) readFileSync(0)\n` +
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n')\n`,
    )
    chmodSync(bin, 0o755)
    return bin
  }

  it('piper: the --help probe and every synthesis get the allowlisted environment', async () => {
    const env = await installed()
    const log = path.join(makeTempDir('piper-log'), 'calls.log')
    await withEnv(
      {
        PIPER_FAKE_LOG: log,
        PIPER_THREADS: '2',
        ESPEAK_DATA_PATH: '/espeak/data',
        UNRELATED_NOISE: 'x',
      },
      async () => {
        const p = createPiperProvider({
          lang: 'pl',
          voice: 'pl_PL-test-medium',
          env: { ...env, FFMPEG_BIN: '/nonexistent/ffmpeg' },
          warn: () => {},
        })
        await p.synthesize('Dzień dobry')
        await p.synthesize('Do widzenia')
      },
    )
    const calls = logLines(log)
    expect(calls).toHaveLength(3) // probe + two clips
    expect(calls[0]!.args).toEqual(['--help'])
    for (const c of calls) {
      expectNoSecrets(c.env, `piper ${c.args[0]}`)
      // What Piper needs still arrives (its own PIPER_* and eSpeak settings).
      expect(c.env.PIPER_THREADS).toBe('2')
      expect(c.env.PIPER_FAKE_LOG).toBe(log)
      expect(c.env.ESPEAK_DATA_PATH).toBe('/espeak/data')
      expect(c.env).not.toHaveProperty('UNRELATED_NOISE')
    }
  })

  it('ffmpeg: the availability probe and the MP3 encode get the allowlisted environment', async () => {
    const log = path.join(makeTempDir('ffmpeg-log'), 'calls.log')
    const bin = fakeFfmpeg(log)
    await withEnv({ UNRELATED_NOISE: 'x' }, () => {
      expect(hasFfmpeg(bin)).toBe(true)
      const wav = pcm16ToWav(Buffer.alloc(3200), 16000)
      // The recording ffmpeg encodes nothing, so the encode is refused after it ran.
      expect(() => wavToMp3(wav, bin, 32)).toThrow(/No MP3 frames/)
    })
    const calls = logLines(log)
    expect(calls.map((c) => c.args.includes('-version'))).toEqual([true, false])
    for (const c of calls) {
      expectNoSecrets(c.env, `ffmpeg ${c.args.join(' ')}`)
      expect(c.env).not.toHaveProperty('UNRELATED_NOISE')
    }
  })

  it('a Piper clip is encoded to MP3 with both tools running without keys', async () => {
    const env = await installed()
    const dir = makeTempDir('both')
    const piperLog = path.join(dir, 'piper.log')
    const ffmpegLog = path.join(dir, 'ffmpeg.log')
    const ffmpeg = fakeFfmpeg(ffmpegLog)
    await withEnv({ PIPER_FAKE_LOG: piperLog }, async () => {
      const p = createPiperProvider({
        lang: 'pl',
        voice: 'pl_PL-test-medium',
        env: { ...env, FFMPEG_BIN: ffmpeg },
        warn: () => {},
      })
      expect(p.format).toBe('mp3')
      await expect(p.synthesize('x')).rejects.toThrow(/No MP3 frames/)
    })
    for (const c of [...logLines(piperLog), ...logLines(ffmpegLog)]) {
      expectNoSecrets(c.env, c.args.join(' '))
    }
  })
})
