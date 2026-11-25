/**
 * Speaker notes -> narration steps. Mirrors how Slidev 52 (@slidev/parser) splits a deck into
 * slides and picks each slide's note, and how it numbers `[click]` markers in notes, so that a
 * step (slide N, click K) is exactly the state Slidev shows at `#/N?clicks=K`.
 */

export type NarrationStep = {
  /** 1-based slide number, as in Slidev's routes. */
  slide: number
  /** Click index on that slide (0 = before the first reveal). */
  click: number
  /** Spoken text for this step (plain text, whitespace collapsed). */
  text: string
}

export type DeckNotes = {
  /** Number of slides in the deck. */
  slides: number
  /** Raw note (last HTML comment at the end of the slide) per slide; '' when there is none. */
  notes: string[]
}

/** Same comment tracking as @slidev/parser: `---` inside an HTML comment is not a separator. */
function advanceHtmlCommentState(line: string, inComment: boolean): boolean {
  let cursor = 0
  while (cursor < line.length) {
    if (inComment) {
      const end = line.indexOf('-->', cursor)
      if (end < 0) return true
      inComment = false
      cursor = end + 3
    } else {
      const start = line.indexOf('<!--', cursor)
      if (start < 0) return false
      const end = line.indexOf('-->', start + 4)
      if (end < 0) return true
      cursor = end + 3
    }
  }
  return inComment
}

/** Raw slide sources (frontmatter included), split like @slidev/parser's parseSync. */
export function splitSlides(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const slides: string[] = []
  let start = 0
  let inComment = false
  const slice = (end: number) => {
    if (start === end) return
    slides.push(lines.slice(start, end).join('\n'))
    start = end + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trimEnd()
    if (inComment) {
      inComment = advanceHtmlCommentState(raw, true)
      continue
    }
    if (line.startsWith('---')) {
      slice(i)
      const next = lines[i + 1]
      if (line[3] !== '-' && next?.trim()) {
        // Per-slide frontmatter: skip to its closing `---`.
        start = i
        for (i += 1; i < lines.length; i++) if (lines[i]!.trimEnd() === '---') break
      }
    } else if (line.trimStart().startsWith('```')) {
      const fence = line.match(/^\s*`+/)![0]
      let j = i + 1
      for (; j < lines.length; j++) if (lines[j]!.startsWith(fence)) break
      if (j !== lines.length) i = j
    } else {
      inComment = advanceHtmlCommentState(raw, false)
    }
  }
  if (start <= lines.length - 1) slice(lines.length)
  return slides
}

/** Drop a leading `---\n…\n---` frontmatter block. */
export function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---[^\n]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/)
  return m ? raw.slice(m[0].length) : raw
}

/** The slide's note: its last HTML comment, if that comment ends the slide (Slidev's rule). */
export function slideNote(raw: string): string {
  const content = stripFrontmatter(raw).trim()
  const comments = Array.from(content.matchAll(/<!--([\s\S]*?)-->/g))
  const last = comments[comments.length - 1]
  if (!last || last.index === undefined) return ''
  return last.index + last[0].length >= content.length ? last[1]!.trim() : ''
}

export function deckNotes(markdown: string): DeckNotes {
  const slides = splitSlides(markdown)
  return { slides: slides.length, notes: slides.map(slideNote) }
}

/**
 * Notes markup -> speakable text: drops HTML tags and Markdown emphasis/code markers, keeps link
 * text, collapses whitespace.
 */
export function toSpeech(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Slidev's notes click marker: `[click]` or `[click:n]` (adds n clicks), case-insensitive. */
const CLICK_MARK_RE = /\[click(?::(\d+))?\]/gi

/** Split one note into (click, text) parts at its click markers. Empty parts are dropped. */
export function splitNoteSteps(note: string): { click: number; text: string }[] {
  const parts: { click: number; text: string }[] = []
  let click = 0
  let last = 0
  const push = (end: number) => {
    const text = toSpeech(note.slice(last, end))
    if (text) parts.push({ click, text })
  }
  for (const m of note.matchAll(CLICK_MARK_RE)) {
    push(m.index)
    click += m[1] === undefined ? 1 : Number(m[1])
    last = m.index + m[0].length
  }
  push(note.length)
  // `[click:0]` does not advance: its text joins the current step.
  const byClick = new Map<number, string>()
  for (const p of parts) {
    byClick.set(p.click, byClick.has(p.click) ? `${byClick.get(p.click)} ${p.text}` : p.text)
  }
  return [...byClick].map(([c, text]) => ({ click: c, text }))
}

/** Every narration step of a deck, in slide/click order. */
export function deckSteps(markdown: string): NarrationStep[] {
  const { notes } = deckNotes(markdown)
  return notes.flatMap((note, i) =>
    splitNoteSteps(note).map((s) => ({ slide: i + 1, click: s.click, text: s.text })),
  )
}
