import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { assertNoSymlinkBelow, mkdirInside, writeFileInside } from '../lib/fs-safe.js'
import { audioDuration, type AudioFormat } from '../lib/narration/audio.js'
import {
  clipFileName,
  clipKey,
  CLIP_FILE_RE,
  MANIFEST_FILE,
  type NarrationClip,
  type NarrationManifest,
} from '../lib/narration/manifest.js'
import { deckSteps } from '../lib/narration/notes.js'
import { resolveAudioQuality, type AudioQuality } from '../lib/narration/quality.js'
import {
  createElevenLabsProvider,
  createPiperProvider,
  loadElevenLabsKey,
  validateProvider,
  type ProviderId,
  type TtsProvider,
} from '../lib/narration/providers.js'
import type { FetchLike } from '../lib/narration/voices.js'
import { childEnv } from '../lib/child-env.js'
import { GIT_HARDENING_ARGS, GIT_TIMEOUT_MS, requireModernGit } from '../lib/git.js'
import { validateLanguage, validateLessonId } from '../lib/validate.js'
import { lessonDir, resolveWorkspaceConfig } from '../lib/workspace.js'

/** Generated narration lives here, per language and lesson; the directory is gitignored. */
export const AUDIO_LOCAL = path.join('audio', 'local')

export function narrationDir(courseDir: string, lang: string, lessonId: string): string {
  validateLanguage(lang)
  validateLessonId(lessonId)
  return path.join(courseDir, AUDIO_LOCAL, lang, lessonId)
}

function git(courseDir: string, args: string[]): { status: number; stdout: string } {
  try {
    requireModernGit()
    // The workspace can be a clone of someone else's: same hardening as for a target repository.
    const stdout = execFileSync(
      'git',
      ['--no-optional-locks', ...GIT_HARDENING_ARGS, '-C', courseDir, ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: childEnv(),
        timeout: GIT_TIMEOUT_MS,
      },
    )
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status?: number; stdout?: string }
    return { status: e.status ?? 128, stdout: e.stdout ?? '' }
  }
}

/**
 * Generated audio must never be committed: when the workspace is inside a git work tree, clips
 * written to audio/local/<lang>/<lesson>/ must be ignored and nothing under audio/local/ may be
 * tracked (except .gitkeep). Outside git there is nothing to commit to.
 */
export function assertAudioNotCommittable(courseDir: string, dir: string): void {
  if (git(courseDir, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return
  const rel = (p: string) => path.relative(courseDir, p).split(path.sep).join('/')
  // Every kind of file a run writes: MP3 clips, WAV clips (lossless preset, no-ffmpeg fallback) and
  // the manifest. A narrower user rule such as `audio/local/**/*.mp3` must not pass.
  for (const name of ['s01-c00-000000000000.mp3', 's01-c00-000000000000.wav', MANIFEST_FILE]) {
    const probe = rel(path.join(dir, name))
    if (git(courseDir, ['check-ignore', '-q', '--', probe]).status !== 0) {
      throw new Error(
        `${probe} would not be ignored by git. Add "audio/local/*" to the workspace .gitignore; generated audio must never be committed.`,
      )
    }
  }
  const tracked = git(courseDir, ['ls-files', '-z', '--', rel(path.join(courseDir, AUDIO_LOCAL))])
    .stdout.split('\0')
    .filter((f) => f && !f.endsWith('/.gitkeep') && f !== '.gitkeep')
  if (tracked.length > 0) {
    throw new Error(
      `Generated audio is tracked by git: ${tracked.join(', ')}. Remove it with \`git rm --cached\`; it must never be committed.`,
    )
  }
}

export type NarrateOptions = {
  lessonId: string
  /** A course language or "all" (default: all languages with a deck). */
  lang?: string
  provider?: string
  voice?: string
  /** ElevenLabs model id (default eleven_multilingual_v2). */
  model?: string
  /** Quality preset; overrides course.json `audioQuality` (default standard). */
  audioQuality?: string
  force?: boolean
  dryRun?: boolean
  prune?: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Tests inject a provider factory or an HTTP fetch. */
  makeProvider?: (lang: string, quality: AudioQuality) => TtsProvider
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export type NarrateLangResult = {
  lang: string
  dir: string
  manifest: string
  clips: number
  generated: number
  reused: number
  /** Characters sent to the provider (generated clips only). */
  charsSent: number
  totalDuration: number
  /** Clip files from earlier runs that the manifest no longer uses. */
  stale: string[]
  /** Stale clips removed by --prune. */
  pruned: string[]
}

export type NarrateResult = {
  courseDir: string
  provider: string
  quality: AudioQuality
  langs: NarrateLangResult[]
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function providerFactory(
  id: ProviderId,
  courseDir: string,
  options: NarrateOptions,
): (lang: string, quality: AudioQuality) => TtsProvider {
  if (id === 'piper') {
    return (lang, quality) =>
      createPiperProvider({
        lang,
        quality,
        voice: options.voice,
        env: options.env,
        warn: options.warn,
      })
  }
  return (_lang, quality) =>
    createElevenLabsProvider({
      quality,
      voice: options.voice,
      model: options.model,
      apiKey: loadElevenLabsKey(courseDir, options.env),
      fetch: options.fetch,
      sleep: options.sleep,
    })
}

/**
 * `course narrate`: one clip per (slide, click) step of each deck's speaker notes, cached by
 * sha256(text + provider + voice + model + settings), written with a manifest.json to
 * audio/local/<lang>/<lesson>/.
 */
export async function runNarrate(options: NarrateOptions): Promise<NarrateResult> {
  const { courseDir, course } = resolveWorkspaceConfig(options.cwd)
  validateLessonId(options.lessonId)
  const root = lessonDir(courseDir, options.lessonId)
  if (!existsSync(root)) throw new Error(`Unknown lesson "${options.lessonId}" (expected ${root})`)
  const providerId = validateProvider(options.provider ?? 'piper')
  if (options.model && providerId !== 'elevenlabs') {
    throw new Error('--model is only used by the elevenlabs provider')
  }

  const quality = resolveAudioQuality(options.audioQuality, course.audioQuality)

  const want = options.lang ?? 'all'
  let langs: string[]
  if (want === 'all') {
    langs = course.languages.filter((l) => existsSync(path.join(root, l, 'slides.md')))
  } else {
    validateLanguage(want)
    if (!course.languages.includes(want)) {
      throw new Error(
        `Language "${want}" is not in course.json languages (${course.languages.join(', ')})`,
      )
    }
    langs = [want]
  }
  if (langs.length === 0) throw new Error(`No decks found under ${root}`)

  const makeProvider = options.makeProvider ?? providerFactory(providerId, courseDir, options)
  const log = options.log ?? (() => {})
  const results: NarrateLangResult[] = []

  for (const lang of langs) {
    const deck = path.join(root, lang, 'slides.md')
    if (!existsSync(deck)) throw new Error(`No deck for ${options.lessonId}/${lang}: ${deck}`)
    assertNoSymlinkBelow(courseDir, deck, 'Deck')
    const steps = deckSteps(readFileSync(deck, 'utf8'))
    if (steps.length === 0) {
      options.warn?.(
        `${options.lessonId}/${lang}: the deck has no speaker notes; nothing to narrate`,
      )
      continue
    }
    const dir = narrationDir(courseDir, lang, options.lessonId)

    if (options.dryRun) {
      const chars = steps.reduce((s, st) => s + st.text.length, 0)
      log(`${lang}: ${steps.length} steps, ${chars} characters (dry run, nothing synthesized)`)
      for (const st of steps) log(`  ${st.slide}.${st.click}  ${st.text.length} chars`)
      results.push({
        lang,
        dir,
        manifest: path.join(dir, MANIFEST_FILE),
        clips: steps.length,
        generated: 0,
        reused: 0,
        charsSent: 0,
        totalDuration: 0,
        stale: [],
        pruned: [],
      })
      continue
    }

    assertAudioNotCommittable(courseDir, dir)
    const provider = makeProvider(lang, quality)
    mkdirInside(courseDir, dir)
    const clips: NarrationClip[] = []
    let generated = 0
    let reused = 0
    let charsSent = 0
    for (const step of steps) {
      const key = clipKey({
        text: step.text,
        provider: provider.id,
        voice: provider.voice,
        model: provider.model,
        settings: provider.settings,
      })
      const file = clipFileName(step.slide, step.click, key, provider.format)
      const abs = path.join(dir, file)
      assertNoSymlinkBelow(courseDir, abs, 'Clip')
      const format = provider.format as AudioFormat
      const at = `${lang} ${step.slide}.${step.click}`
      let seconds: number | undefined
      if (!options.force && existsSync(abs) && lstatSync(abs).size > 0) {
        try {
          seconds = audioDuration(readFileSync(abs), format)
          reused++
        } catch (err) {
          // A clip that is not valid audio (an older bad response, a truncated file) is not reused.
          log(
            `${at}: cached clip ${file} is not valid ${format} audio (${errorText(err)}); regenerating`,
          )
        }
      }
      if (seconds === undefined) {
        log(`${at}: synthesizing ${step.text.length} chars`)
        const audio = await provider.synthesize(step.text)
        // Validate before caching: a proxy's HTML page or a truncated MP3 must not stay in the cache.
        try {
          seconds = audioDuration(audio, format)
        } catch (err) {
          throw new Error(
            `The ${provider.id} response for ${at} is not valid ${format} audio (${errorText(err)}); nothing was cached for ${file}`,
          )
        }
        writeFileInside(courseDir, abs, audio)
        generated++
        charsSent += step.text.length
      }
      clips.push({
        slide: step.slide,
        click: step.click,
        file,
        duration: Math.round(seconds * 1000) / 1000,
        key,
        text: step.text,
      })
    }

    const manifest: NarrationManifest = {
      schemaVersion: 1,
      lesson: options.lessonId,
      lang,
      provider: provider.id,
      voice: provider.voice,
      model: provider.model,
      format: provider.format,
      settings: provider.settings,
      totalDuration: Math.round(clips.reduce((s, c) => s + c.duration, 0) * 1000) / 1000,
      clips,
    }
    const manifestPath = path.join(dir, MANIFEST_FILE)
    writeFileInside(courseDir, manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    // Clips from earlier runs (other text/voice/provider) are kept unless --prune: switching
    // providers back and forth must not cost a paid provider twice.
    const current = new Set(clips.map((c) => c.file))
    const stale = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && CLIP_FILE_RE.test(e.name) && !current.has(e.name))
      .map((e) => e.name)
      .sort()
    if (options.prune) {
      for (const name of stale) rmSync(path.join(dir, name))
    }
    results.push({
      lang,
      dir,
      manifest: manifestPath,
      clips: clips.length,
      generated,
      reused,
      charsSent,
      totalDuration: manifest.totalDuration,
      stale: options.prune ? [] : stale,
      pruned: options.prune ? stale : [],
    })
  }
  return { courseDir, provider: providerId, quality, langs: results }
}
