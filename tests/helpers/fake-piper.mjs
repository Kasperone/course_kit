#!/usr/bin/env node
// Stand-in for the Piper CLI in tests (lives in the repo because /tmp may be noexec).
// `--help` exits 0. Otherwise it reads the text from stdin and, with --output-raw, writes 16-bit
// mono PCM silence: 100 samples per character. FAKE_PIPER_LOG, if set, gets one JSON line per call
// with argv and stdin. FAKE_PIPER_FAIL=1 makes it exit 3.
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  if (process.env.PIPER_FAKE_LOG) {
    appendFileSync(
      process.env.PIPER_FAKE_LOG,
      JSON.stringify({ args, text: null, env: process.env }) + '\n',
    )
  }
  process.exit(0)
}
const text = readFileSync(0, 'utf8')
if (process.env.PIPER_FAKE_LOG) {
  appendFileSync(
    process.env.PIPER_FAKE_LOG,
    JSON.stringify({ args, text, env: process.env }) + '\n',
  )
}
if (process.env.PIPER_FAKE_FAIL === '1') {
  process.stderr.write('fake piper: synthesis failed\n')
  process.exit(3)
}
process.stdout.write(Buffer.alloc(text.trim().length * 100 * 2))
