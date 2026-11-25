import { createHash } from 'node:crypto'
import { isPlainObject } from '../validate.js'
import type { AudioFormat } from './audio.js'

/** `audio/local/<lang>/<lesson>/manifest.json`: which clip belongs to which (slide, click). */
export type NarrationClip = {
  slide: number
  click: number
  /** Clip file name in the manifest's directory (no path separators). */
  file: string
  /** Seconds. */
  duration: number
  /** sha256 cache key (see clipKey). */
  key: string
  /** Spoken text (also usable as a caption/transcript line). */
  text: string
}

export type NarrationManifest = {
  schemaVersion: 1
  lesson: string
  lang: string
  provider: string
  voice: string
  model: string
  format: AudioFormat
  settings: Record<string, unknown>
  totalDuration: number
  clips: NarrationClip[]
}

export const MANIFEST_FILE = 'manifest.json'

/** Clip file names: `s<slide>-c<click>-<key prefix>.<ext>`. Nothing else is ever served. */
export const CLIP_FILE_RE = /^s\d{2,3}-c\d{2,3}-[0-9a-f]{12}\.(?:mp3|wav)$/

/** Cache key: sha256 over the text and everything that changes the audio. */
export function clipKey(input: {
  text: string
  provider: string
  voice: string
  model: string
  settings: Record<string, unknown>
}): string {
  const settings = Object.fromEntries(
    Object.entries(input.settings).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: input.text,
        provider: input.provider,
        voice: input.voice,
        model: input.model,
        settings,
      }),
    )
    .digest('hex')
}

export function clipFileName(
  slide: number,
  click: number,
  key: string,
  format: AudioFormat,
): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `s${pad(slide)}-c${pad(click)}-${key.slice(0, 12)}.${format}`
}

/** Parse a manifest; clips with an unsafe file name or bad numbers are rejected. */
export function parseManifest(raw: unknown, what: string): NarrationManifest {
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.clips)) {
    throw new Error(`${what}: not a narration manifest (schemaVersion 1)`)
  }
  for (const k of ['lesson', 'lang', 'provider', 'voice', 'model'] as const) {
    if (typeof raw[k] !== 'string') throw new Error(`${what}: "${k}" must be a string`)
  }
  if (raw.format !== 'mp3' && raw.format !== 'wav') throw new Error(`${what}: bad "format"`)
  const clips = raw.clips.map((c: unknown, i: number): NarrationClip => {
    const at = `${what}: clips[${i}]`
    if (!isPlainObject(c)) throw new Error(`${at} must be an object`)
    const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
    if (!int(c.slide) || (c.slide as number) < 1 || !int(c.click)) {
      throw new Error(`${at}: slide/click must be non-negative integers (slide >= 1)`)
    }
    if (typeof c.file !== 'string' || !CLIP_FILE_RE.test(c.file)) {
      throw new Error(`${at}: unsafe clip file name ${JSON.stringify(c.file)}`)
    }
    if (typeof c.duration !== 'number' || !Number.isFinite(c.duration) || c.duration < 0) {
      throw new Error(`${at}: bad duration`)
    }
    if (typeof c.key !== 'string' || !/^[0-9a-f]{64}$/.test(c.key))
      throw new Error(`${at}: bad key`)
    return {
      slide: c.slide as number,
      click: c.click as number,
      file: c.file,
      duration: c.duration,
      key: c.key,
      text: typeof c.text === 'string' ? c.text : '',
    }
  })
  return {
    schemaVersion: 1,
    lesson: raw.lesson as string,
    lang: raw.lang as string,
    provider: raw.provider as string,
    voice: raw.voice as string,
    model: raw.model as string,
    format: raw.format,
    settings: isPlainObject(raw.settings) ? raw.settings : {},
    totalDuration: clips.reduce((s, c) => s + c.duration, 0),
    clips,
  }
}
