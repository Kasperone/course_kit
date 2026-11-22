import { escapeControls } from './context-pack/markdown.js'
import { redactUrlCredentials } from './context-pack/redact.js'

/**
 * Text that is safe to print to a terminal. Messages quote repository content (file names, glob
 * patterns, git output) and the target can be any third-party repo: raw ESC/OSC/CSI sequences could
 * retitle the terminal, recolour or hide lines and spoof warnings. Line breaks stay (git errors are
 * multi-line); every other control character becomes a visible escape. The password of a
 * `user:password@host` URL is dropped too: git, Slidev and the answer CLIs echo proxy URLs
 * (`HTTPS_PROXY=http://user:secret@proxy:3128`) in their errors, and the proxy variables are passed on.
 */
export function terminalSafe(text: string): string {
  return redactUrlCredentials(text).split(/\r?\n/).map(escapeControls).join('\n')
}
