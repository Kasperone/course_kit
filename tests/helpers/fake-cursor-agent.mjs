#!/usr/bin/env node
// Stand-in for the Cursor agent CLI (`cursor-agent`) in tests; see fake-cli-core.mjs.
import { run } from './fake-cli-core.mjs'

await run('cursor')
