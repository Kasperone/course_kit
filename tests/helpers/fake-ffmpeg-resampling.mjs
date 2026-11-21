#!/usr/bin/env node
// A misbehaving ffmpeg for tests: `-version` works, but encoding ignores the input and returns
// MPEG-1 Layer III frames at 44.1 kHz mono, i.e. it "resamples". course_kit must refuse the result.
import { readFileSync } from 'node:fs'

if (process.argv.includes('-version')) process.exit(0)
readFileSync(0)
const frame = Buffer.alloc(417)
frame.set([0xff, 0xfb, 0x90, 0xc0])
process.stdout.write(Buffer.concat(Array.from({ length: 10 }, () => frame)))
