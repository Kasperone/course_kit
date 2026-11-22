import { childEnv } from '../child-env.js'

/**
 * Environments for the TTS tools course_kit starts. Both come from the shared allowlist
 * (`childEnv()`), so an exported API key (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, any `*_TOKEN`,
 * `*_SECRET`, ...) never reaches Piper, ffmpeg or anything they spawn. ElevenLabs is called over
 * HTTP in this process; its key is not needed by any child.
 */

/**
 * Piper (a Python/onnxruntime program in a venv) needs its own settings (`PIPER_*`, eSpeak data
 * paths `ESPEAK_*`), the loader paths for its bundled libraries and onnxruntime/OpenMP tuning.
 */
export function piperEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnv({
    env,
    extra: [
      'PIPER_*',
      'ESPEAK_*',
      'LD_LIBRARY_PATH',
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'OMP_*',
      'ORT_*',
    ],
  })
}

/** ffmpeg encodes from stdin to stdout and needs nothing beyond the base allowlist. */
export function ffmpegEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnv({ env })
}
