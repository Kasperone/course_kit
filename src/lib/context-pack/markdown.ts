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

/** Inline code span that survives backticks and newlines in `text` (e.g. odd file names). */
export function inlineCode(text: string): string {
  const flat = text.replace(/\r?\n/g, '\\n')
  const ticks = '`'.repeat(longestRun(flat, '`') + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${flat}${pad}${ticks}`
}

/** Escape text for a Markdown table cell. */
export function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
