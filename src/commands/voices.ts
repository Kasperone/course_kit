import { existsSync } from 'node:fs'
import path from 'node:path'
import { piperBin } from '../lib/narration/providers.js'
import {
  installPiperVoice,
  PIPER_VOICES,
  PIPER_VOICES_REVISION,
  voicesDir,
  type FetchLike,
  type InstallResult,
} from '../lib/narration/voices.js'

export const VOICE_ENGINES = ['piper'] as const

/** `course voices install <engine> <voice>`: explicit download; narrate never downloads. */
export async function runVoicesInstall(options: {
  engine: string
  voice: string
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
}): Promise<InstallResult> {
  if (options.engine !== 'piper') {
    throw new Error(
      `Unknown voice engine "${options.engine}" (expected: ${VOICE_ENGINES.join(', ')}). ElevenLabs voices are not installed locally; pass --voice <voice-id> to course narrate.`,
    )
  }
  return installPiperVoice(options.voice, { env: options.env, fetch: options.fetch })
}

export type VoiceListing = {
  dir: string
  piper: string
  revision: string
  voices: { name: string; lang: string; installed: boolean; license: string; dataset: string }[]
}

/** `course voices list`: installable Piper voices, install state and licences. */
export function runVoicesList(env: NodeJS.ProcessEnv = process.env): VoiceListing {
  const dir = voicesDir(env)
  return {
    dir,
    piper: piperBin(env),
    revision: PIPER_VOICES_REVISION,
    voices: PIPER_VOICES.map((v) => ({
      name: v.name,
      lang: v.lang,
      installed: existsSync(path.join(dir, v.name, v.files.model.name)),
      license: v.datasetLicense,
      dataset: v.dataset,
    })),
  }
}
