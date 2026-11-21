#!/usr/bin/env node
// Stand-in for the Claude Code CLI (`claude`) in tests; see fake-cli-core.mjs.
import { run } from './fake-cli-core.mjs'

await run('claude')
