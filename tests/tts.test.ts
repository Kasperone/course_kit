import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNarrate } from '../src/commands/narrate.js'
import { runVoicesInstall } from '../src/commands/voices.js'
import { hasFfmpeg, mp3Duration, wavDuration } from '../src/lib/narration/audio.js'
import {
  createElevenLabsProvider,
  createPiperProvider,
  loadElevenLabsKey,
} from '../src/lib/narration/providers.js'
import {
  installPiperVoice,
  loadInstalledVoice,
  PIPER_VOICES,
  voicesDir,
} from '../src/lib/narration/voices.js'
import { runBounded } from './helpers/bounded.js'
import { fakeVoice } from './helpers/fake-voice.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { makeTempDir } from './helpers/tmp.js'

const FAKE_PIPER = path.join(__dirname, 'helpers', 'fake-piper.mjs')
describe('Piper voices', () => {
  it('lists exactly the two approved voices with permissive data licences', () => {
    expect(PIPER_VOICES.map((v) => [v.name, v.datasetLicense])).toEqual([
      ['pl_PL-darkman-medium', 'CC0'],
      ['en_US-ljspeech-medium', 'Public domain'],
    ])
    for (const v of PIPER_VOICES) {
      for (const f of Object.values(v.files)) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('installs a voice into COURSE_KIT_VOICES_DIR at the pinned revision, verifying sha256', async () => {
    const env = { COURSE_KIT_VOICES_DIR: makeTempDir('voices') }
    const v = fakeVoice()
    const r = await installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] })
    expect(r.dir).toBe(path.join(env.COURSE_KIT_VOICES_DIR, v.info.name))
    expect(r.downloaded).toHaveLength(3)
    expect(
      v.urls.every((u) => u.startsWith('https://huggingface.co/rhasspy/piper-voices/resolve/')),
    ).toBe(true)
    expect(v.urls[0]).toContain('/e9c8a39444359388adaa94255becb37a5a2b8e51/')
    expect(JSON.parse(readFileSync(path.join(r.dir, 'voice.json'), 'utf8'))).toMatchObject({
      engine: 'piper',
      datasetLicense: 'CC0',
    })

    const again = await installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] })
    expect(again.downloaded).toEqual([])
    expect(again.verified).toHaveLength(3)

    const loaded = loadInstalledVoice(v.info.name, env, [v.info])
    expect(loaded).toMatchObject({
      sampleRate: 16000,
      lang: 'pl',
      modelSha256: v.info.files.model.sha256,
    })
  })

  it('refuses a download whose sha256 does not match and leaves nothing behind', async () => {
    const env = { COURSE_KIT_VOICES_DIR: makeTempDir('voices') }
    const v = fakeVoice()
    v.bodies[v.info.files.model.name] = Buffer.from('tampered')
    await expect(
      installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] }),
    ).rejects.toThrow(/sha256 mismatch/)
    const dir = path.join(env.COURSE_KIT_VOICES_DIR, v.info.name)
    expect(readdirSync(dir).filter((f) => f.endsWith('.onnx') || f.endsWith('.part'))).toEqual([])
  })

  it('stops a stalled download and passes an abort signal to fetch', async () => {
    const env = { COURSE_KIT_VOICES_DIR: makeTempDir('voices') }
    const v = fakeVoice()
    const signals: Array<AbortSignal | undefined> = []
    const stalled = (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }
    await expect(
      installPiperVoice(v.info.name, { env, fetch: stalled, registry: [v.info], timeoutMs: 50 }),
    ).rejects.toThrow(/Download did not finish within 0\.1 s/)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    // The normal path still works with the signal in place.
    await installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] })
  }, 10_000)

  it('negative control: without the abort signal a stalled download never ends', async () => {
    const env = { COURSE_KIT_VOICES_DIR: makeTempDir('voices') }
    const v = fakeVoice()
    // A fetch that ignores its signal is what a removed timeout looks like to the code under test.
    const deaf = () => new Promise<Response>(() => {})
    const outcome = await Promise.race([
      installPiperVoice(v.info.name, { env, fetch: deaf, registry: [v.info], timeoutMs: 50 }).then(
        () => 'finished',
        () => 'settled',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 800)),
    ])
    expect(outcome).toBe('still waiting')
  })

  it('rejects unknown voices, bad names and other engines', async () => {
    const env = { COURSE_KIT_VOICES_DIR: makeTempDir('voices') }
    await expect(
      installPiperVoice('pl_PL-mc_speech-medium', {
        env,
        fetch: () => Promise.reject(new Error('no network')),
      }),
    ).rejects.toThrow(/Unknown Piper voice/)
    await expect(installPiperVoice('../../etc', { env })).rejects.toThrow(/Invalid Piper voice/)
    await expect(runVoicesInstall({ engine: 'elevenlabs', voice: 'x' })).rejects.toThrow(
      /Unknown voice engine/,
    )
  })

  it('defaults to the user cache and never to the repo', () => {
    expect(voicesDir({ XDG_CACHE_HOME: '/home/u/.cache' })).toBe(
      '/home/u/.cache/course_kit/piper-voices',
    )
    expect(voicesDir({ COURSE_KIT_VOICES_DIR: '/data/voices' })).toBe('/data/voices')
  })

  it('narrate never downloads: a missing voice is an error that names the install command', async () => {
    const env = { COURSE_KIT_VOICES_DIR: makeTempDir('voices'), PIPER_BIN: FAKE_PIPER }
    expect(() => createPiperProvider({ lang: 'pl', env })).toThrow(
      /course voices install piper pl_PL-darkman-medium/,
    )
  })
})

describe('Piper provider (fake piper binary)', () => {
  async function installed() {
    const env: NodeJS.ProcessEnv = {
      COURSE_KIT_VOICES_DIR: makeTempDir('voices'),
      PIPER_BIN: FAKE_PIPER,
    }
    const v = fakeVoice('pl_PL-test-medium')
    await installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] })
    return { env, v }
  }

  it('runs piper as an external process with text on stdin and wraps raw PCM as WAV', async () => {
    const { env } = await installed()
    const warnings: string[] = []
    const p = createPiperProvider({
      lang: 'pl',
      voice: 'pl_PL-test-medium',
      env: { ...env, FFMPEG_BIN: '/nonexistent/ffmpeg' },
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join()).toMatch(/ffmpeg not found/)
    expect(p.format).toBe('wav')
    expect(p.model).toMatch(/^pl_PL-test-medium@sha256:[0-9a-f]{64}$/)
    expect(p.settings).toMatchObject({
      noiseScale: 0.5,
      lengthScale: 1,
      noiseW: 0.3,
      sampleRate: 16000,
    })

    const text = '-n --help "quoted" text'
    // The piper child gets the allowlisted real environment (PATH, PIPER_* ...), not the resolution env.
    const log = path.join(makeTempDir('piperlog'), 'calls.log')
    process.env.PIPER_FAKE_LOG = log
    let wav: Buffer
    try {
      wav = await p.synthesize(text)
    } finally {
      delete process.env.PIPER_FAKE_LOG
    }
    expect(wavDuration(wav)).toBeCloseTo((text.length * 100) / 16000, 3)
    const call = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!) as {
      args: string[]
      text: string
    }
    expect(call.text).toBe(`${text}\n`)
    expect(call.args).not.toContain(text)
    expect(call.args).toEqual(
      expect.arrayContaining(['--output-raw', '--model', '--config', '--noise-scale', '0.5']),
    )
  })

  it.skipIf(!hasFfmpeg('ffmpeg'))('encodes MP3 through ffmpeg when it is available', async () => {
    const { env } = await installed()
    const p = createPiperProvider({ lang: 'pl', voice: 'pl_PL-test-medium', env })
    expect(p.format).toBe('mp3')
    const mp3 = await p.synthesize('Dzień dobry')
    expect(mp3Duration(mp3)).toBeGreaterThan(0.05)
  })

  it('reports piper failures and a missing binary', async () => {
    const { env } = await installed()
    const p = createPiperProvider({
      lang: 'pl',
      voice: 'pl_PL-test-medium',
      env: { ...env, FFMPEG_BIN: '/nonexistent/ffmpeg' },
    })
    process.env.PIPER_FAKE_FAIL = '1'
    try {
      await expect(p.synthesize('x')).rejects.toThrow(
        /Piper exited with 3: fake piper: synthesis failed/,
      )
    } finally {
      delete process.env.PIPER_FAKE_FAIL
    }
    expect(() =>
      createPiperProvider({
        lang: 'pl',
        voice: 'pl_PL-test-medium',
        env: { ...env, PIPER_BIN: '/nonexistent/piper' },
      }),
    ).toThrow(/Piper is not available/)
  })

  // The code under test blocks (spawnSync), so a missing timeout would freeze the suite: these run
  // in a child process under an outer limit. The negative controls run the same scenario with the
  // timeout disabled (0) and must hang, which shows the limit is what ends it.
  it('stops a Piper that does not finish', async () => {
    const run = await runBounded('piper-hang', [makeTempDir('voices'), '400'], 20_000)
    expect(run.hung, run.stdout + run.stderr).toBe(false)
    expect(run.stdout).toMatch(/RESULT: Piper did not finish within 0\.4 s/)
  }, 40_000)

  it('negative control: a hung Piper never finishes without the timeout', async () => {
    const run = await runBounded('piper-hang', [makeTempDir('voices'), '0'], 6_000)
    expect(run.hung).toBe(true)
    expect(run.stdout).not.toContain('RESULT:')
  }, 30_000)

  it('stops an ffmpeg that does not finish', async () => {
    const run = await runBounded('ffmpeg-hang', ['400'], 20_000)
    expect(run.hung, run.stdout + run.stderr).toBe(false)
    expect(run.stdout).toMatch(/RESULT: ffmpeg did not finish within 0\.4 s and was stopped/)
  }, 40_000)

  it('negative control: a hung ffmpeg never finishes without the timeout', async () => {
    const run = await runBounded('ffmpeg-hang', ['0'], 6_000)
    expect(run.hung).toBe(true)
    expect(run.stdout).not.toContain('RESULT:')
  }, 30_000)

  it('refuses a voice in the wrong language', async () => {
    const { env } = await installed()
    expect(() => createPiperProvider({ lang: 'en', voice: 'pl_PL-test-medium', env })).toThrow(
      /speaks "pl"/,
    )
  })

  it('narrates a workspace end to end with --provider piper', async () => {
    const { env } = await installed()
    const { workspace } = await makeWorkspace(undefined, { languages: ['pl'] })
    writeFileSync(
      path.join(workspace, 'lessons', '01-placeholder', 'pl', 'slides.md'),
      '---\ntitle: x\n---\n\n# A\n\n<!--\nCześć. [click] Dalej.\n-->\n',
    )
    const r = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      provider: 'piper',
      voice: 'pl_PL-test-medium',
      env: { ...env, FFMPEG_BIN: '/nonexistent/ffmpeg' },
      warn: () => {},
    })
    expect(r.langs[0]).toMatchObject({ lang: 'pl', clips: 2, generated: 2 })
    const manifest = JSON.parse(readFileSync(r.langs[0]!.manifest, 'utf8')) as {
      provider: string
      voice: string
      format: string
    }
    expect(manifest).toMatchObject({ provider: 'piper', voice: 'pl_PL-test-medium', format: 'wav' })
  })
})

describe('ElevenLabs provider (mocked HTTP, no key, no live calls)', () => {
  const KEY = 'sk_test_0123456789abcdef_SECRET'
  const mp3Frame = () => {
    const f = Buffer.alloc(417)
    f.set([0xff, 0xfb, 0x90, 0x00])
    return Buffer.concat(Array.from({ length: 40 }, () => f))
  }

  function mockFetch(responses: (() => Response)[]) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      const next = responses.shift()
      return next ? Promise.resolve(next()) : Promise.reject(new Error('unexpected request'))
    }
    return { fetch, calls }
  }

  it('posts the text with the key only in the xi-api-key header', async () => {
    const { fetch, calls } = mockFetch([() => new Response(new Uint8Array(mp3Frame()))])
    const p = createElevenLabsProvider({ voice: 'Voice123', apiKey: KEY, fetch })
    expect(p).toMatchObject({
      id: 'elevenlabs',
      voice: 'Voice123',
      model: 'eleven_multilingual_v2',
      format: 'mp3',
    })
    expect(JSON.stringify(p)).not.toContain(KEY)
    const audio = await p.synthesize('Cześć, świecie.')
    expect(mp3Duration(audio)).toBeGreaterThan(1)
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/Voice123?output_format=mp3_44100_128',
    )
    expect(url).not.toContain(KEY)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY)
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Cześć, świecie.',
      model_id: 'eleven_multilingual_v2',
    })
    expect(init.body as string).not.toContain(KEY)
  })

  it('retries 429/5xx and never puts the key in an error message', async () => {
    const echo = () => new Response(`bad key ${KEY}`, { status: 401 })
    const { fetch, calls } = mockFetch([() => new Response('slow down', { status: 429 }), echo])
    const p = createElevenLabsProvider({
      voice: 'Voice123',
      apiKey: KEY,
      fetch,
      sleep: () => Promise.resolve(),
    })
    const err = (await p.synthesize('x').catch((e: unknown) => e)) as Error
    expect(calls).toHaveLength(2)
    expect(err.message).toMatch(/ElevenLabs HTTP 401/)
    expect(err.message).not.toContain(KEY)

    const boom = createElevenLabsProvider({
      voice: 'Voice123',
      apiKey: KEY,
      fetch: () => Promise.reject(new Error(`connect failed for ${KEY}`)),
    })
    const err2 = (await boom.synthesize('x').catch((e: unknown) => e)) as Error
    expect(err2.message).toMatch(/request failed/)
    expect(err2.message).not.toContain(KEY)
  })

  it('redacts the key before cutting the error text, so a key at the limit leaves no prefix', async () => {
    // 280 filler characters, then the key: it starts before the 300-character cut and ends after it.
    const body = `${'x'.repeat(280)}${KEY}`
    const { fetch } = mockFetch([() => new Response(body, { status: 401 })])
    const p = createElevenLabsProvider({ voice: 'Voice123', apiKey: KEY, fetch })
    const err = (await p.synthesize('x').catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/ElevenLabs HTTP 401/)
    expect(err.message).not.toContain(KEY.slice(0, 8))
    expect(err.message).toContain('‹redacted›')
  })

  it('times out a stalled request, retries it, and gives up with a clear error', async () => {
    const calls: RequestInit[] = []
    const stalled = (_url: string, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }
    const p = createElevenLabsProvider({
      voice: 'Voice123',
      apiKey: KEY,
      fetch: stalled,
      sleep: () => Promise.resolve(),
      timeoutMs: 50,
    })
    const err = (await p.synthesize('x').catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/did not answer within 0\.1 s \(3 attempts\)/)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true)
    expect(err.message).not.toContain(KEY)

    // A timeout then a good answer succeeds.
    let n = 0
    const flaky = (url: string, init?: RequestInit) =>
      ++n === 1 ? stalled(url, init) : Promise.resolve(new Response(new Uint8Array(mp3Frame())))
    const ok = createElevenLabsProvider({
      voice: 'Voice123',
      apiKey: KEY,
      fetch: flaky,
      sleep: () => Promise.resolve(),
      timeoutMs: 50,
    })
    expect(mp3Duration(await ok.synthesize('x'))).toBeGreaterThan(1)
  }, 10_000)

  it('negative control: without the abort signal a stalled request never ends', async () => {
    const deaf = () => new Promise<Response>(() => {})
    const p = createElevenLabsProvider({
      voice: 'Voice123',
      apiKey: KEY,
      fetch: deaf,
      sleep: () => Promise.resolve(),
      timeoutMs: 50,
    })
    const outcome = await Promise.race([
      p.synthesize('x').then(
        () => 'finished',
        () => 'settled',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 800)),
    ])
    expect(outcome).toBe('still waiting')
  })

  it('validates voice and model ids and requires a voice', () => {
    expect(() => createElevenLabsProvider({ apiKey: KEY })).toThrow(/needs a voice id/)
    expect(() => createElevenLabsProvider({ voice: '../v1/user', apiKey: KEY })).toThrow(
      /Invalid ElevenLabs voice id/,
    )
    expect(() => createElevenLabsProvider({ voice: 'ok', model: 'a b', apiKey: KEY })).toThrow(
      /Invalid ElevenLabs model id/,
    )
  })

  it('reads the key from the environment, else from the workspace .env', () => {
    const dir = makeTempDir('envkey')
    expect(loadElevenLabsKey(dir, { ELEVENLABS_API_KEY: KEY })).toBe(KEY)
    expect(() => loadElevenLabsKey(dir, {})).toThrow(/ELEVENLABS_API_KEY is not set/)
    writeFileSync(path.join(dir, '.env'), `# local\nOTHER=1\nexport ELEVENLABS_API_KEY="${KEY}"\n`)
    expect(loadElevenLabsKey(dir, {})).toBe(KEY)
  })

  it('narrates with elevenlabs without the key reaching output, logs or files', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    writeFileSync(path.join(workspace, '.env'), `ELEVENLABS_API_KEY=${KEY}\n`)
    writeFileSync(
      path.join(workspace, 'lessons', '01-placeholder', 'en', 'slides.md'),
      '---\ntitle: x\n---\n\n# A\n\n<!--\nHello. [click] World.\n-->\n',
    )
    const { fetch, calls } = mockFetch([
      () => new Response(new Uint8Array(mp3Frame())),
      () => new Response(new Uint8Array(mp3Frame())),
    ])
    const out: string[] = []
    const r = await runNarrate({
      lessonId: '01-placeholder',
      cwd: workspace,
      provider: 'elevenlabs',
      voice: 'Voice123',
      env: {},
      fetch,
      log: (m) => out.push(m),
      warn: (m) => out.push(m),
    })
    expect(calls).toHaveLength(2)
    expect(r.langs[0]).toMatchObject({ clips: 2, generated: 2 })
    expect(out.join('\n')).not.toContain(KEY)
    const dir = path.join(workspace, 'audio', 'local', 'en', '01-placeholder')
    for (const f of readdirSync(dir))
      expect(readFileSync(path.join(dir, f), 'latin1')).not.toContain(KEY)
    expect(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toContain(
      '"provider": "elevenlabs"',
    )
    // The workspace template ignores .env, so the key file is never committed either.
    expect(readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toMatch(/^\.env$/m)
  })

  it('--model is rejected for piper', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    await expect(
      runNarrate({ lessonId: '01-placeholder', cwd: workspace, provider: 'piper', model: 'm' }),
    ).rejects.toThrow(/only used by the elevenlabs/)
  })
})
