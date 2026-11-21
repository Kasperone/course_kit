import type { AudioFormat } from './audio.js'

/**
 * Audio quality presets for `course narrate --audio-quality` (or course.json `audioQuality`).
 * They only choose the container and bitrate; the sample rate and channel count always stay those
 * of the TTS output (never upsampled, resampled or downmixed).
 */
export const AUDIO_QUALITIES = ['compact', 'standard', 'high', 'lossless'] as const
export type AudioQuality = (typeof AUDIO_QUALITIES)[number]

export const DEFAULT_AUDIO_QUALITY: AudioQuality = 'standard'

export type QualityPreset = {
  format: AudioFormat
  /** Requested MP3 bitrate in kbit/s (undefined for lossless WAV). */
  kbps?: number
  description: string
}

export const AUDIO_QUALITY_PRESETS: Record<AudioQuality, QualityPreset> = {
  compact: { format: 'mp3', kbps: 64, description: 'MP3 64 kbit/s' },
  standard: { format: 'mp3', kbps: 128, description: 'MP3 128 kbit/s' },
  high: { format: 'mp3', kbps: 192, description: 'MP3 192 kbit/s' },
  lossless: { format: 'wav', description: 'WAV, the TTS output as is' },
}

export function validateAudioQuality(value: unknown, what = 'Audio quality'): AudioQuality {
  if (typeof value !== 'string' || !(AUDIO_QUALITIES as readonly string[]).includes(value)) {
    throw new Error(
      `${what} must be one of ${AUDIO_QUALITIES.join(', ')}, got ${JSON.stringify(value)}`,
    )
  }
  return value as AudioQuality
}

/** CLI flag, else course.json `audioQuality`, else the default (standard). */
export function resolveAudioQuality(cli?: string, course?: AudioQuality): AudioQuality {
  if (cli !== undefined) return validateAudioQuality(cli, '--audio-quality')
  return course ?? DEFAULT_AUDIO_QUALITY
}

/**
 * The MP3 bitrate actually used at a sample rate. MPEG-1 Layer III (32/44.1/48 kHz) allows up to
 * 320 kbit/s; MPEG-2/2.5 (below 32 kHz, e.g. Piper's 22.05 kHz) only up to 160 kbit/s. Encoders cap
 * a higher request silently, so it is capped here explicitly (and recorded) instead of upsampling.
 */
export function mp3Bitrate(kbps: number, sampleRate: number): number {
  return sampleRate < 32000 ? Math.min(kbps, 160) : Math.min(kbps, 320)
}
