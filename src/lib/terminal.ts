import { escapeControls } from './context-pack/markdown.js'

/**
 * Text that is safe to print to a terminal. Messages quote repository content (file names, glob
 * patterns, git output) and the target can be any third-party repo: raw ESC/OSC/CSI sequences could
 * retitle the terminal, recolour or hide lines and spoof warnings. Line breaks stay (git errors are
 * multi-line); every other control character becomes a visible escape.
 */
export function terminalSafe(text: string): string {
  return text.split(/\r?\n/).map(escapeControls).join('\n')
}
