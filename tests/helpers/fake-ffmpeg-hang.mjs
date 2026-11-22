#!/usr/bin/env node
// A hung ffmpeg for tests: `-version` works, encoding reads its input and then never finishes.
import { readFileSync } from 'node:fs'

if (process.argv.includes('-version')) process.exit(0)
readFileSync(0)
setInterval(() => {}, 1000)
