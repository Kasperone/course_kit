import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileNoFollow } from '../fs-safe.js'

/**
 * Piper voices course_kit knows how to install: exact files from rhasspy/piper-voices on Hugging
 * Face at a pinned revision, each checked against its sha256. Voices are downloaded only by
 * `course voices install piper <voice>`, never during `course narrate`, and live in a user cache
 * (COURSE_KIT_VOICES_DIR, default ~/.cache/course_kit/piper-voices), never in a repo.
 *
 * Licences come from each voice's MODEL_CARD at that revision (the card is data; re-read it when
 * the revision changes). Only voices trained on CC0 / public-domain / CC-BY data are listed, so
 * generated audio can be redistributed.
 */

export const PIPER_VOICES_REPO = 'rhasspy/piper-voices'
/** rhasspy/piper-voices main at 2026-11-20. */
export const PIPER_VOICES_REVISION = 'e9c8a39444359388adaa94255becb37a5a2b8e51'

export type VoiceFile = { name: string; sha256: string; size?: number }

export type PiperVoiceInfo = {
  name: string
  /** Course language this voice speaks. */
  lang: string
  /** Directory in the piper-voices repo. */
  repoPath: string
  files: { model: VoiceFile; config: VoiceFile; card: VoiceFile }
  dataset: string
  datasetLicense: string
  training: string
  /** Minimum Piper version from the model card, if it states one. */
  minPiper?: string
}

export const PIPER_VOICES: PiperVoiceInfo[] = [
  {
    name: 'pl_PL-darkman-medium',
    lang: 'pl',
    repoPath: 'pl/pl_PL/darkman/medium',
    files: {
      model: {
        name: 'pl_PL-darkman-medium.onnx',
        sha256: 'cf757ee307e3a7c23d5d8f69934deab51683d01c1c6be376d3e13146020f1530',
        size: 63221984,
      },
      config: {
        name: 'pl_PL-darkman-medium.onnx.json',
        sha256: '1208a7d257daba8d0a421e9f55ec8210db009d785cd4f7e0b0c9936b3168f1a0',
      },
      card: {
        name: 'MODEL_CARD',
        sha256: 'a2c89d3059a830d47fb0159973088c02ae3a4c7e56235a3abe63b9507340bdab',
      },
    },
    dataset: 'darkman, https://github.com/OHF-Voice/voice-datasets',
    datasetLicense: 'CC0',
    training: 'Finetuned from the rdh base model (nl_BE, CC0)',
    minPiper: '1.5',
  },
  {
    name: 'en_US-ljspeech-medium',
    lang: 'en',
    repoPath: 'en/en_US/ljspeech/medium',
    files: {
      model: {
        name: 'en_US-ljspeech-medium.onnx',
        sha256: '6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22',
        size: 63531379,
      },
      config: {
        name: 'en_US-ljspeech-medium.onnx.json',
        sha256: '141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860',
      },
      card: {
        name: 'MODEL_CARD',
        sha256: 'fbee1529c89d36b3fe76d7e9f3f832dce17f44900a52d76a9bda735654766b4d',
      },
    },
    dataset: 'LJ Speech, https://keithito.com/LJ-Speech-Dataset/',
    datasetLicense: 'Public domain',
    training: 'Trained from scratch on LJ Speech',
  },
]

/** Default Piper voice per course language. */
export const DEFAULT_PIPER_VOICE: Record<string, string> = {
  pl: 'pl_PL-darkman-medium',
  en: 'en_US-ljspeech-medium',
}

/** Piper voice names: `<ll>_<CC>-<name>-<quality>`. Used as a directory name, so validated. */
export const PIPER_VOICE_RE = /^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(?:x_low|low|medium|high)$/

export function validatePiperVoice(name: string): string {
  if (typeof name !== 'string' || !PIPER_VOICE_RE.test(name)) {
    throw new Error(
      `Invalid Piper voice ${JSON.stringify(name)} (expected e.g. "pl_PL-darkman-medium")`,
    )
  }
  return name
}

/** Where Piper voices live: COURSE_KIT_VOICES_DIR, else $XDG_CACHE_HOME or ~/.cache. */
export function voicesDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COURSE_KIT_VOICES_DIR) return path.resolve(env.COURSE_KIT_VOICES_DIR)
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(cache, 'course_kit', 'piper-voices')
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function voiceUrl(voice: PiperVoiceInfo, file: VoiceFile, revision = PIPER_VOICES_REVISION) {
  return `https://huggingface.co/${PIPER_VOICES_REPO}/resolve/${revision}/${voice.repoPath}/${file.name}`
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type InstallResult = {
  voice: PiperVoiceInfo
  dir: string
  downloaded: string[]
  verified: string[]
}

/**
 * `course voices install piper <voice>`: download the voice's model, config and model card at the
 * pinned revision into voicesDir()/<voice>/, verifying each sha256 before it is moved into place.
 * Files already present with the right hash are kept.
 */
export async function installPiperVoice(
  name: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: FetchLike; registry?: PiperVoiceInfo[] } = {},
): Promise<InstallResult> {
  validatePiperVoice(name)
  const registry = options.registry ?? PIPER_VOICES
  const voice = registry.find((v) => v.name === name)
  if (!voice) {
    throw new Error(
      `Unknown Piper voice "${name}". Installable voices: ${registry.map((v) => v.name).join(', ')}`,
    )
  }
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike)
  const dir = path.join(voicesDir(options.env), voice.name)
  mkdirSync(dir, { recursive: true })
  const downloaded: string[] = []
  const verified: string[] = []
  for (const file of [voice.files.config, voice.files.card, voice.files.model]) {
    const dest = path.join(dir, file.name)
    if (existsSync(dest) && sha256(readFileSync(dest)) === file.sha256) {
      verified.push(file.name)
      continue
    }
    const url = voiceUrl(voice, file)
    const res = await doFetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`)
    const data = Buffer.from(await res.arrayBuffer())
    const actual = sha256(data)
    if (actual !== file.sha256) {
      throw new Error(
        `sha256 mismatch for ${file.name}: expected ${file.sha256}, got ${actual}. Nothing was installed.`,
      )
    }
    const part = `${dest}.part`
    try {
      writeFileNoFollow(part, data)
      renameSync(part, dest)
    } catch (err) {
      rmSync(part, { force: true })
      throw err
    }
    downloaded.push(file.name)
  }
  writeFileNoFollow(
    path.join(dir, 'voice.json'),
    JSON.stringify(
      {
        engine: 'piper',
        voice: voice.name,
        source: `https://huggingface.co/${PIPER_VOICES_REPO}`,
        revision: PIPER_VOICES_REVISION,
        files: Object.values(voice.files).map((f) => ({ name: f.name, sha256: f.sha256 })),
        dataset: voice.dataset,
        datasetLicense: voice.datasetLicense,
        training: voice.training,
      },
      null,
      2,
    ) + '\n',
  )
  return { voice, dir, downloaded, verified }
}

export type InstalledVoice = {
  name: string
  dir: string
  model: string
  config: string
  /** sha256 of the .onnx model (part of the narration cache key). */
  modelSha256: string
  sampleRate: number
  /** Inference defaults from the voice config. */
  inference: { noise_scale?: number; length_scale?: number; noise_w?: number }
  /** Language code from the voice name (`pl_PL` -> `pl`). */
  lang: string
}

/** An installed voice, verified against the registry hash when the voice is a known one. */
export function loadInstalledVoice(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  registry: PiperVoiceInfo[] = PIPER_VOICES,
): InstalledVoice {
  validatePiperVoice(name)
  const dir = path.join(voicesDir(env), name)
  const model = path.join(dir, `${name}.onnx`)
  const config = path.join(dir, `${name}.onnx.json`)
  if (!existsSync(model) || !existsSync(config)) {
    throw new Error(
      `Piper voice "${name}" is not installed in ${dir}. Run: course voices install piper ${name}`,
    )
  }
  const modelSha256 = sha256(readFileSync(model))
  const known = registry.find((v) => v.name === name)
  if (known && known.files.model.sha256 !== modelSha256) {
    throw new Error(
      `Piper voice "${name}" in ${dir} does not match the pinned sha256. Reinstall it: course voices install piper ${name}`,
    )
  }
  let cfg: { audio?: { sample_rate?: unknown }; inference?: Record<string, unknown> }
  try {
    cfg = JSON.parse(readFileSync(config, 'utf8')) as typeof cfg
  } catch (err) {
    throw new Error(
      `${config} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const sampleRate = cfg.audio?.sample_rate
  if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`${config}: audio.sample_rate must be a positive integer`)
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return {
    name,
    dir,
    model,
    config,
    modelSha256,
    sampleRate,
    inference: {
      noise_scale: num(cfg.inference?.noise_scale),
      length_scale: num(cfg.inference?.length_scale),
      noise_w: num(cfg.inference?.noise_w),
    },
    lang: name.split('_')[0]!,
  }
}

/** audio/ATTRIBUTION.md for a new workspace: voices, licences, and the never-commit rule. */
export function attributionMarkdown(registry: PiperVoiceInfo[] = PIPER_VOICES): string {
  const rows = registry
    .map(
      (v) =>
        `| ${v.lang} | Piper \`${v.name}\` | ${v.dataset} | ${v.datasetLicense} | ${v.training} |`,
    )
    .join('\n')
  return `# Audio attribution

Narration clips are **generated** by \`course narrate\` into \`audio/local/<lang>/<lesson>/\`, which is
gitignored. They are build artefacts: **never commit generated audio** (or API keys). \`course build\`
copies them into \`dist/\` (also gitignored) for local viewing.

## Voices

| Lang | Provider / voice | Voice training data | Data licence | Model |
|---|---|---|---|---|
${rows}

- Piper voices come from [${PIPER_VOICES_REPO}](https://huggingface.co/${PIPER_VOICES_REPO}) at revision
  \`${PIPER_VOICES_REVISION}\` (repository licence: MIT), installed with
  \`course voices install piper <voice>\` and checked against pinned sha256 hashes. Each voice's
  \`MODEL_CARD\` is stored next to it in the voice cache.
- The Piper engine (OHF-Voice/piper1-gpl, GPL-3.0-or-later) runs as a separate program; it is not
  part of this workspace. The GPL covers the program, not in general the output it produces (see
  the GNU GPL FAQ on program output); the voice data licences above are what matter for the clips.
- Clips say which provider, voice and model produced them in \`manifest.json\`.

## ElevenLabs

If a lesson is narrated with \`--provider elevenlabs\`, the clips stay in \`audio/local/\` like any
other narration. Use and publishing are governed by your ElevenLabs plan's terms (the free plan is
non-commercial and requires attribution). Record the voice id and plan here before sharing a build:

| Lang | Voice id | Model | Plan / licence |
|---|---|---|---|
|  |  |  |  |
`
}
