// Pure helpers of the narration player (global-top.vue), kept out of the component so tests can run
// them without a browser.

/**
 * What the player does when `audio.play()` rejects.
 * - `ignore`: an AbortError. Setting `src` or calling `pause()` while an earlier `play()` is pending
 *   rejects that promise (HTML media spec), e.g. when the viewer presses "next" twice quickly. The
 *   newer request decides what happens; narration must stay on.
 * - `off`: the browser refuses to play (autoplay policy, unsupported format): switch narration off.
 * - `quiet`: any other failure (network, decode): stay on, just not "playing".
 */
export type PlayFailure = 'ignore' | 'off' | 'quiet'

export function playFailure(err: unknown): PlayFailure {
  const name =
    typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  if (name === 'AbortError') return 'ignore'
  if (name === 'NotAllowedError' || name === 'NotSupportedError') return 'off'
  return 'quiet'
}

/**
 * Generation counter for play requests: every play() and stop() starts a new generation, so a
 * promise that settles after a newer request (or a stop) can tell that it is stale and must not
 * touch the player's state.
 */
export function createPlayGeneration(): {
  begin: () => number
  isCurrent: (id: number) => boolean
} {
  let current = 0
  return {
    begin: () => ++current,
    isCurrent: (id) => id === current,
  }
}
