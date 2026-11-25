import { childEnv } from '../child-env.js'

/**
 * Environments for the TTS tools course_kit starts. Both come from the shared allowlist
 * (`childEnv()`), so an exported API key (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, any `*_TOKEN`,
 * `*_SECRET`, ...) never reaches Piper, ffmpeg or anything they spawn. ElevenLabs is called over
 * HTTP in this process; its key is not needed by any child.
 */

/**
 * Network and git settings that the base allowlist keeps for git and Slidev but that neither Piper
 * nor ffmpeg uses (they read stdin and write stdout; no network, no ssh, no git): proxy variables
 * (a URL can carry `user:pass@`), the ssh agent socket and `GIT_*` (including the prompt switch).
 */
const NOT_FOR_AUDIO_TOOLS = /^(?:(?:HTTPS?|ALL|NO|FTP)_PROXY|SSH_AUTH_SOCK|GIT_.*)$/i

function audioToolEnv(env: NodeJS.ProcessEnv, extra: string[] = []): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(childEnv({ env, extra })).filter(([name]) => !NOT_FOR_AUDIO_TOOLS.test(name)),
  )
}

/**
 * Piper (a Python/onnxruntime program in a venv) needs its own settings (`PIPER_*`, eSpeak data
 * paths `ESPEAK_*`), the loader paths for its bundled libraries and onnxruntime/OpenMP tuning.
 */
export function piperEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return audioToolEnv(env, [
    'PIPER_*',
    'ESPEAK_*',
    'LD_LIBRARY_PATH',
    'DYLD_LIBRARY_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
    'OMP_*',
    'ORT_*',
  ])
}

/** ffmpeg encodes from stdin to stdout and needs nothing beyond path, home, locale and temp dir. */
export function ffmpegEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return audioToolEnv(env)
}
