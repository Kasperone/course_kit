import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CourseJson } from '../../commands/init.js'
import { estimateTokens } from '../context-pack/estimate.js'
import { assertNoSymlinkBelow } from '../fs-safe.js'
import { slideNote, splitNoteSteps, splitSlides, stripFrontmatter } from '../narration/notes.js'
import { headmatterOf } from '../slidev.js'
import { validateLanguage } from '../validate.js'
import { lessonDir } from '../workspace.js'

/**
 * What a Q&A answer may draw on (ADR 0005): the lesson's context pack (built by `course context`
 * from the pinned commit, secrets already denylisted and redacted) and the deck's slides and
 * speaker notes in the deck language. No retrieval: the whole material goes into the prompt.
 */

export type PackStatus = 'ok' | 'missing' | 'stale' | 'too-large'

export type SlideMaterial = {
  /** 1-based slide number, as in Slidev routes. */
  n: number
  title: string
  /** Slide Markdown without frontmatter and speaker notes. */
  body: string
  /** Narration steps from the notes, numbered like Slidev clicks. */
  steps: { click: number; text: string }[]
}

export type LessonMaterials = {
  lessonId: string
  lang: string
  title: string
  slides: SlideMaterial[]
  slidesTokens: number
  pack: {
    status: PackStatus
    /** Pack Markdown (null unless status is ok or stale). */
    text: string | null
    /** Commit the pack was built from, when known. */
    commit: string | null
    tokens: number
  }
}

export const CONTEXT_PACK_FILE = 'context-pack.md'
export const CONTEXT_PACK_META = 'context-pack.json'
/** Packs above this size are not even read (the token cap rejects them anyway). */
const MAX_PACK_BYTES = 4 * 1024 * 1024
const MAX_DECK_BYTES = 2 * 1024 * 1024

export class LessonNotFoundError extends Error {}

/** lessons/<id>/<lang>/slides.md, after validating both segments and refusing symlinks. */
export function deckFile(courseDir: string, course: CourseJson, lessonId: string, lang: string) {
  validateLanguage(lang)
  if (!course.languages.includes(lang)) {
    throw new LessonNotFoundError(`Language "${lang}" is not in course.json languages`)
  }
  const file = path.join(lessonDir(courseDir, lessonId), lang, 'slides.md')
  if (!existsSync(file)) throw new LessonNotFoundError(`No deck for ${lessonId}/${lang}`)
  assertNoSymlinkBelow(courseDir, file, 'Deck')
  if (!lstatSync(file).isFile()) throw new LessonNotFoundError(`No deck for ${lessonId}/${lang}`)
  return file
}

function deckTitle(deck: string, fallback: string): string {
  const block = headmatterOf(deck)
  const m = block?.match(/^title:\s*(.+?)\s*$/m)
  if (!m) return fallback
  const raw = m[1]!
  try {
    return raw.startsWith('"') ? String(JSON.parse(raw)) : raw.replace(/^'(.*)'$/, '$1')
  } catch {
    return raw
  }
}

/** Slides with their notes split into steps, exactly as narration and Slidev count clicks. */
export function deckMaterials(deck: string): SlideMaterial[] {
  return splitSlides(deck).map((raw, i) => {
    const content = stripFrontmatter(raw).trim()
    const note = slideNote(raw)
    const body = note ? content.slice(0, content.lastIndexOf('<!--')).trim() : content
    const title = body.match(/^#{1,3}\s+(.+?)\s*#*\s*$/m)?.[1] ?? ''
    return { n: i + 1, title, body, steps: splitNoteSteps(note) }
  })
}

/** The commit a pack was built from: context-pack.json, else the pack's header table. */
function packCommit(markdown: string, metaFile: string): string | null {
  if (existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { pinnedCommit?: unknown }
      if (typeof meta.pinnedCommit === 'string') return meta.pinnedCommit
    } catch {
      // fall through to the Markdown header
    }
  }
  return markdown.match(/^\|\s*Pinned commit\s*\|\s*`([0-9a-f]{40,64})`/m)?.[1] ?? null
}

type CacheEntry = { stamp: string; materials: LessonMaterials }
const cache = new Map<string, CacheEntry>()

function stampOf(files: string[], extra: string): string {
  return [
    extra,
    ...files.map((f) => {
      if (!existsSync(f)) return `${f}:-`
      const st = lstatSync(f)
      return `${f}:${st.size}:${st.mtimeMs}`
    }),
  ].join('|')
}

/**
 * Load (or reuse) the materials for one lesson deck. Re-read when the deck, the pack or the
 * pinned commit change, so edits during `course dev` apply to the next question.
 */
export function loadLessonMaterials(
  courseDir: string,
  course: CourseJson,
  lessonId: string,
  lang: string,
  maxPackTokens: number,
): LessonMaterials {
  const deck = deckFile(courseDir, course, lessonId, lang)
  const dir = lessonDir(courseDir, lessonId)
  const packFile = path.join(dir, CONTEXT_PACK_FILE)
  const metaFile = path.join(dir, CONTEXT_PACK_META)
  const key = `${courseDir}\0${lessonId}\0${lang}`
  const stamp = stampOf([deck, packFile, metaFile], `${course.pinnedCommit}:${maxPackTokens}`)
  const hit = cache.get(key)
  if (hit && hit.stamp === stamp) return hit.materials

  if (lstatSync(deck).size > MAX_DECK_BYTES) throw new Error(`${lessonId}/${lang}: deck too large`)
  const deckText = readFileSync(deck, 'utf8')
  const slides = deckMaterials(deckText)

  let pack: LessonMaterials['pack'] = { status: 'missing', text: null, commit: null, tokens: 0 }
  if (existsSync(packFile)) {
    assertNoSymlinkBelow(courseDir, packFile, 'Context pack')
    const size = lstatSync(packFile).size
    if (size > MAX_PACK_BYTES) {
      pack = { status: 'too-large', text: null, commit: null, tokens: Math.ceil(size / 4) }
    } else {
      const text = readFileSync(packFile, 'utf8')
      const tokens = estimateTokens(text)
      const commit = packCommit(text, metaFile)
      pack =
        tokens > maxPackTokens
          ? { status: 'too-large', text: null, commit, tokens }
          : {
              status: commit && commit !== course.pinnedCommit ? 'stale' : 'ok',
              text,
              commit,
              tokens,
            }
    }
  }

  const materials: LessonMaterials = {
    lessonId,
    lang,
    title: deckTitle(deckText, lessonId),
    slides,
    slidesTokens: estimateTokens(
      slides.map((s) => `${s.body}\n${s.steps.map((t) => t.text).join('\n')}`).join('\n'),
    ),
    pack,
  }
  cache.set(key, { stamp, materials })
  return materials
}
