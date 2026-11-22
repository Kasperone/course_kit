import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ffmpegBin, hasFfmpeg, pcm16ToWav, wavToMp3, type AudioFormat } from './audio.js'
import { piperEnv } from './env.js'
import {
  AUDIO_QUALITY_PRESETS,
  DEFAULT_AUDIO_QUALITY,
  mp3Bitrate,
  type AudioQuality,
} from './quality.js'
import { DEFAULT_PIPER_VOICE, loadInstalledVoice, type FetchLike } from './voices.js'

/**
 * A text-to-speech backend. Everything that changes the audio for a given text is exposed as
 * provider/voice/model/settings, because those fields form the narration cache key.
 */
export interface TtsProvider {
  readonly id: string
  readonly voice: string
  readonly model: string
  readonly settings: Record<string, unknown>
  readonly format: AudioFormat
  synthesize(text: string): Promise<Buffer>
}

export const PROVIDERS = ['piper', 'elevenlabs'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export function validateProvider(id: string): ProviderId {
  if (!(PROVIDERS as readonly string[]).includes(id)) {
    throw new Error(`Unknown TTS provider "${id}" (expected one of: ${PROVIDERS.join(', ')})`)
  }
  return id as ProviderId
}

// ---------------------------------------------------------------------------------------------
// Piper (offline). Piper is GPL-3.0: course_kit only runs it as an external process and never
// bundles or links it (ADR 0004).

/** Default venv binary from the README install steps. */
export function defaultPiperVenvBin(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(data, 'course_kit', 'piper-venv', 'bin', 'piper')
}

/** PIPER_BIN, else the course_kit venv's piper if it exists, else `piper` on PATH. */
export function piperBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PIPER_BIN) return env.PIPER_BIN
  const venv = defaultPiperVenvBin()
  return existsSync(venv) ? venv : 'piper'
}

export type PiperOptions = {
  lang: string
  voice?: string
  env?: NodeJS.ProcessEnv
  /** Quality preset (default standard). MP3 presets fall back to WAV (with a warning) without ffmpeg. */
  quality?: AudioQuality
  warn?: (message: string) => void
}

export function createPiperProvider(options: PiperOptions): TtsProvider {
  const env = options.env ?? process.env
  const voiceName = options.voice ?? DEFAULT_PIPER_VOICE[options.lang]
  if (!voiceName) {
    throw new Error(`No default Piper voice for language "${options.lang}"; pass --voice`)
  }
  const voice = loadInstalledVoice(voiceName, env)
  if (voice.lang !== options.lang.split('-')[0]) {
    throw new Error(
      `Piper voice "${voiceName}" speaks "${voice.lang}", but the deck language is "${options.lang}"`,
    )
  }
  const bin = piperBin(env)
  const probe = spawnSync(bin, ['--help'], { stdio: 'ignore', env: piperEnv() })
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `Piper is not available (${bin}). Install it in a venv (see README "Narration") or set PIPER_BIN.`,
    )
  }
  const quality = options.quality ?? DEFAULT_AUDIO_QUALITY
  const preset = AUDIO_QUALITY_PRESETS[quality]
  let format: AudioFormat = preset.format
  const ffmpeg = ffmpegBin(env)
  if (format === 'mp3' && !hasFfmpeg(ffmpeg)) {
    options.warn?.(`ffmpeg not found (${ffmpeg}); writing WAV clips instead of MP3`)
    format = 'wav'
  }
  // Effective bitrate at the voice's own sample rate (never upsampled to reach a higher one).
  const kbps = format === 'mp3' ? mp3Bitrate(preset.kbps!, voice.sampleRate) : undefined
  if (kbps !== undefined && kbps < preset.kbps!) {
    options.warn?.(
      `${quality}: ${preset.kbps} kbit/s is above the MP3 maximum at ${voice.sampleRate} Hz; using ${kbps} kbit/s (the sample rate is never changed)`,
    )
  }
  const settings = {
    lengthScale: voice.inference.length_scale ?? 1,
    noiseScale: voice.inference.noise_scale ?? 0.667,
    noiseW: voice.inference.noise_w ?? 0.8,
    sentenceSilence: 0.25,
    sampleRate: voice.sampleRate,
    channels: 1,
    quality,
    format,
    ...(kbps !== undefined ? { bitrate: kbps } : {}),
  }
  return {
    id: 'piper',
    voice: voiceName,
    model: `${voiceName}@sha256:${voice.modelSha256}`,
    settings,
    format,
    synthesize(text: string): Promise<Buffer> {
      // Text goes in on stdin (one line), never as argv: a leading "-" would be read as an option.
      const r = spawnSync(
        bin,
        [
          '--model',
          voice.model,
          '--config',
          voice.config,
          '--output-raw',
          '--length-scale',
          String(settings.lengthScale),
          '--noise-scale',
          String(settings.noiseScale),
          '--noise-w-scale',
          String(settings.noiseW),
          '--sentence-silence',
          String(settings.sentenceSilence),
        ],
        {
          input: text.replace(/\s+/g, ' ').trim() + '\n',
          cwd: voice.dir,
          maxBuffer: 512 * 1024 * 1024,
          env: piperEnv(),
        },
      )
      if (r.error)
        return Promise.reject(new Error(`Piper failed to start (${bin}): ${r.error.message}`))
      if (r.status !== 0 || r.stdout.length === 0) {
        const err = r.stderr.toString('utf8').trim().split('\n').slice(-5).join('\n')
        return Promise.reject(new Error(`Piper exited with ${String(r.status)}: ${err}`))
      }
      const wav = pcm16ToWav(r.stdout, voice.sampleRate)
      try {
        return Promise.resolve(kbps !== undefined ? wavToMp3(wav, ffmpeg, kbps) : wav)
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// ElevenLabs (HTTP API). The API key is read from the environment or the workspace's gitignored
// .env, sent only in the xi-api-key header, and never printed, logged or written anywhere.

export const ELEVENLABS_KEY_ENV = 'ELEVENLABS_API_KEY'
export const ELEVENLABS_API = 'https://api.elevenlabs.io'
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2'
/**
 * ElevenLabs output format per quality preset (all 44.1 kHz, as delivered; nothing is re-encoded).
 * Per the API docs, mp3_44100_192 needs the Creator tier or above and wav_44100 the Pro tier.
 */
export const ELEVENLABS_OUTPUT: Record<
  AudioQuality,
  { outputFormat: string; format: AudioFormat; kbps?: number }
> = {
  compact: { outputFormat: 'mp3_44100_64', format: 'mp3', kbps: 64 },
  standard: { outputFormat: 'mp3_44100_128', format: 'mp3', kbps: 128 },
  high: { outputFormat: 'mp3_44100_192', format: 'mp3', kbps: 192 },
  lossless: { outputFormat: 'wav_44100', format: 'wav' },
}

/** ElevenLabs voice and model ids are short alphanumeric/underscore tokens (used in a URL path). */
const ELEVENLABS_ID_RE = /^[A-Za-z0-9_]{1,64}$/

/** Read ELEVENLABS_API_KEY from the environment, else from `<courseDir>/.env`. */
export function loadElevenLabsKey(courseDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[ELEVENLABS_KEY_ENV]?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(courseDir, '.env')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const value = m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim()
      if (value) return value
    }
  }
  throw new Error(
    `${ELEVENLABS_KEY_ENV} is not set. Export it or put it in the workspace's .env (gitignored).`,
  )
}

export type ElevenLabsOptions = {
  voice?: string
  model?: string
  apiKey: string
  fetch?: FetchLike
  /** Wait between retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
  quality?: AudioQuality
}

/** Replace every occurrence of the key, so it can never leak through an error message. */
function redactKey(text: string, key: string): string {
  return key ? text.split(key).join('‹redacted›') : text
}

export function createElevenLabsProvider(options: ElevenLabsOptions): TtsProvider {
  const { apiKey } = options
  if (!options.voice) {
    throw new Error('ElevenLabs needs a voice id: pass --voice <voice-id>')
  }
  const voice = options.voice
  const model = options.model ?? ELEVENLABS_DEFAULT_MODEL
  for (const [what, id] of [
    ['voice id', voice],
    ['model id', model],
  ] as const) {
    if (!ELEVENLABS_ID_RE.test(id))
      throw new Error(`Invalid ElevenLabs ${what}: ${JSON.stringify(id)}`)
  }
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const quality = options.quality ?? DEFAULT_AUDIO_QUALITY
  const out = ELEVENLABS_OUTPUT[quality]
  const settings = {
    quality,
    outputFormat: out.outputFormat,
    format: out.format,
    ...(out.kbps !== undefined ? { bitrate: out.kbps } : {}),
  }
  const url = `${ELEVENLABS_API}/v1/text-to-speech/${voice}?output_format=${out.outputFormat}`
  return {
    id: 'elevenlabs',
    voice,
    model,
    settings,
    format: out.format,
    async synthesize(text: string): Promise<Buffer> {
      const body = JSON.stringify({ text, model_id: model })
      for (let attempt = 1; ; attempt++) {
        let res: Response
        try {
          res = await doFetch(url, {
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'content-type': 'application/json',
              accept: out.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
            },
            body,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`ElevenLabs request failed: ${redactKey(msg, apiKey)}`)
        }
        if (res.ok) return Buffer.from(await res.arrayBuffer())
        const retry = res.status === 429 || res.status >= 500
        if (retry && attempt < 3) {
          await sleep(1000 * attempt)
          continue
        }
        const detail = redactKey((await res.text().catch(() => '')).slice(0, 300), apiKey)
        throw new Error(`ElevenLabs HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
    },
  }
}
