/**
 * Time limits for everything narration waits on, so a hung Piper or ffmpeg process or a stalled
 * connection cannot block `course narrate` or `course voices install` forever (git calls have
 * `GIT_TIMEOUT_MS` for the same reason). Generous: a clip takes seconds.
 */

/** One Piper synthesis. */
export const PIPER_TIMEOUT_MS = 5 * 60_000
/** One WAV -> MP3 encode. */
export const FFMPEG_TIMEOUT_MS = 2 * 60_000
/** `piper --help` / `ffmpeg -version`: only checks that the tool starts. */
export const PROBE_TIMEOUT_MS = 30_000
/** One ElevenLabs request, response body included. */
export const ELEVENLABS_TIMEOUT_MS = 2 * 60_000
/** One voice file download (the model is ~60 MB). */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

/** spawnSync options that stop a hung child: the limit, and a kill it cannot ignore. */
export function spawnLimit(timeoutMs: number): { timeout: number; killSignal: 'SIGKILL' } {
  return { timeout: timeoutMs, killSignal: 'SIGKILL' }
}

/** True for the error `spawnSync` reports when its `timeout` expired. */
export function timedOut(err: Error | undefined): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
}

export function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`
}
