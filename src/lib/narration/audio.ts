import { spawnSync } from 'node:child_process'
import { ffmpegEnv } from './env.js'
import { FFMPEG_TIMEOUT_MS, PROBE_TIMEOUT_MS, seconds, spawnLimit, timedOut } from './timeouts.js'

/** Audio container formats a narration clip can have. */
export type AudioFormat = 'mp3' | 'wav'

export const AUDIO_MIME: Record<AudioFormat, string> = { mp3: 'audio/mpeg', wav: 'audio/wav' }

/** A 16-bit little-endian mono PCM WAV file around raw samples. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  const blockAlign = channels * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Duration in seconds of a PCM WAV file (walks the RIFF chunks). */
export function wavDuration(buf: Buffer): number {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Not a WAV file')
  }
  let byteRate = 0
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16)
    if (id === 'data') {
      if (!byteRate) throw new Error('WAV data chunk before fmt chunk')
      return Math.min(size, buf.length - offset - 8) / byteRate
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV file has no data chunk')
}

// MPEG audio frame header tables (MPEG-1/2/2.5, Layer III).
const MP3_BITRATES: Record<'v1' | 'v2', number[]> = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
}

/** Duration in seconds of a Layer III MP3 stream, by walking its frames (CBR or VBR). */
export function mp3Duration(buf: Buffer): number {
  let offset = 0
  // Skip an ID3v2 tag.
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((buf[6]! & 0x7f) << 21) |
      ((buf[7]! & 0x7f) << 14) |
      ((buf[8]! & 0x7f) << 7) |
      (buf[9]! & 0x7f)
    offset = 10 + size
  }
  let seconds = 0
  let frames = 0
  while (offset + 4 <= buf.length) {
    const b1 = buf[offset + 1]!
    const b2 = buf[offset + 2]!
    if (buf[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      offset++
      continue
    }
    const version = (b1 >> 3) & 0x03 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (b1 >> 1) & 0x03 // 1 = Layer III
    const bitrateIdx = (b2 >> 4) & 0x0f
    const rateIdx = (b2 >> 2) & 0x03
    const rates = MP3_RATES[version]
    if (layer !== 1 || !rates || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) {
      offset++
      continue
    }
    const sampleRate = rates[rateIdx]!
    const kbps = MP3_BITRATES[version === 3 ? 'v1' : 'v2'][bitrateIdx]!
    const samples = version === 3 ? 1152 : 576
    const padding = (b2 >> 1) & 0x01
    const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding
    if (length < 4) break
    seconds += samples / sampleRate
    frames++
    offset += length
  }
  if (frames === 0) throw new Error('No MP3 frames found')
  return seconds
}

export function audioDuration(buf: Buffer, format: AudioFormat): number {
  return format === 'wav' ? wavDuration(buf) : mp3Duration(buf)
}

/** ffmpeg to use for MP3 encoding: FFMPEG_BIN, else `ffmpeg` on PATH (never installed by us). */
export function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_BIN || 'ffmpeg'
}

export function hasFfmpeg(bin: string): boolean {
  const r = spawnSync(bin, ['-hide_banner', '-version'], {
    stdio: 'ignore',
    env: ffmpegEnv(),
    ...spawnLimit(PROBE_TIMEOUT_MS),
  })
  return r.status === 0
}

/** Sample rate and channel count of a PCM WAV file (from its fmt chunk). */
export function wavFormat(buf: Buffer): { sampleRate: number; channels: number } {
  wavDuration(buf) // validates the RIFF structure
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      return { channels: buf.readUInt16LE(offset + 10), sampleRate: buf.readUInt32LE(offset + 12) }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV file has no fmt chunk')
}

/** Sample rate and channel count of an MP3 stream (from its first Layer III frame header). */
export function mp3Format(buf: Buffer): { sampleRate: number; channels: number } {
  let offset = 0
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    offset =
      10 +
      (((buf[6]! & 0x7f) << 21) |
        ((buf[7]! & 0x7f) << 14) |
        ((buf[8]! & 0x7f) << 7) |
        (buf[9]! & 0x7f))
  }
  for (; offset + 4 <= buf.length; offset++) {
    const b1 = buf[offset + 1]!
    if (buf[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) continue
    const version = (b1 >> 3) & 0x03
    const rates = MP3_RATES[version]
    const rateIdx = (buf[offset + 2]! >> 2) & 0x03
    if (((b1 >> 1) & 0x03) !== 1 || !rates || rateIdx === 3) continue
    const mode = (buf[offset + 3]! >> 6) & 0x03 // 3 = single channel
    return { sampleRate: rates[rateIdx]!, channels: mode === 3 ? 1 : 2 }
  }
  throw new Error('No MP3 frames found')
}

/**
 * WAV -> MP3 at `kbps` through ffmpeg's stdin/stdout (no temp files, no shell). The sample rate and
 * channels are left as they are (no -ar/-ac): the result is checked against the source, so a clip is
 * never resampled, upsampled or downmixed. Pass a bitrate valid for the sample rate (mp3Bitrate).
 */
export function wavToMp3(
  wav: Buffer,
  bin: string,
  kbps: number,
  timeoutMs = FFMPEG_TIMEOUT_MS,
): Buffer {
  const r = spawnSync(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'wav',
      '-i',
      'pipe:0',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      `${kbps}k`,
      '-f',
      'mp3',
      'pipe:1',
    ],
    { input: wav, maxBuffer: 512 * 1024 * 1024, env: ffmpegEnv(), ...spawnLimit(timeoutMs) },
  )
  if (timedOut(r.error)) {
    throw new Error(`ffmpeg did not finish within ${seconds(timeoutMs)} and was stopped (${bin})`)
  }
  if (r.error) throw new Error(`ffmpeg failed to start (${bin}): ${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(
      `ffmpeg exited with ${String(r.status)}: ${r.stderr.toString('utf8').trim().slice(0, 500)}`,
    )
  }
  const src = wavFormat(wav)
  const out = mp3Format(r.stdout)
  if (out.sampleRate !== src.sampleRate || out.channels !== src.channels) {
    throw new Error(
      `ffmpeg changed the audio format (${src.sampleRate} Hz/${src.channels} ch -> ${out.sampleRate} Hz/${out.channels} ch); refusing to resample`,
    )
  }
  return r.stdout
}
