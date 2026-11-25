/**
 * Fence-safe Markdown embedding for repository content. Embedded text must never be able to close
 * the surrounding fence or inline span, otherwise its headings leak into the pack's structure.
 */

function longestRun(text: string, ch: string): number {
  let best = 0
  let run = 0
  for (const c of text) {
    run = c === ch ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

/** A fenced code block whose fence is longer than any backtick run inside `content`. */
export function fence(content: string, info = ''): string {
  const ticks = '`'.repeat(Math.max(3, longestRun(content, '`') + 1))
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return `${ticks}${info}\n${body}\n${ticks}`
}

/**
 * Control characters as visible escapes. CommonMark ends a line at \n, \r\n and a lone \r, so any
 * of them in a file name could start a new block (e.g. a heading); the rest are escaped as well.
 * The same text is printed to the terminal, where ESC (CSI/OSC sequences), the C1 controls (U+0080
 * to U+009F, 8-bit CSI/OSC in some terminals) and bidirectional overrides could retitle the window,
 * hide output or reorder a spoofed line, so all of them become visible escapes.
 */
const NAMED_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

export function escapeControls(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => {
      const code = c.charCodeAt(0)
      return (
        NAMED_ESCAPES[c] ??
        (code <= 0xff
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`)
      )
    },
  )
}

/** Inline code span that survives backticks and line breaks in `text` (e.g. odd file names). */
export function inlineCode(text: string): string {
  const flat = escapeControls(text)
  const ticks = '`'.repeat(longestRun(flat, '`') + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${flat}${pad}${ticks}`
}

/** Escape text for a Markdown table cell. */
export function tableCell(text: string): string {
  return escapeControls(text).replace(/\|/g, '\\|')
}

/**
 * The first `maxLines` lines, each prefixed with its line number (`     N|`). The prefix also keeps
 * embedded Markdown from starting at column 0 (fences, PlantUML blocks the workspace guard scans).
 */
export function numberedExcerpt(
  content: string,
  maxLines: number,
): { text: string; truncated: number } {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const slice = lines.slice(0, maxLines)
  return {
    text: slice.map((line, i) => `${String(i + 1).padStart(6, ' ')}|${line}`).join('\n'),
    truncated: lines.length - slice.length,
  }
}
