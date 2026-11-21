// Shared logic of the stand-ins for the Claude Code CLI (`fake-claude.mjs`) and the Cursor agent
// CLI (`fake-cursor-agent.mjs`). They print the same stream-json shapes as the real CLIs and make no
// network calls. Environment:
//   FAKE_CLI_LOG       append one JSON line per call (argv, stdin, cwd, cwd entries, system prompt
//                      file, provider-key variable names seen, CLAUDE_CODE_MAX_OUTPUT_TOKENS)
//   FAKE_CLI_MODE      stream (default) | whole | no-partial | not-logged-in | fail | hang | flood
//                      | stray (answers, but leaves a background process behind, like
//                      cursor-agent's worker-server)
//   FAKE_CLI_ANSWER    answer text (default: a lesson part and a [[general]] part)
//   FAKE_CLI_LOGGED_OUT=1   the login-status command reports "not logged in"
//   FAKE_CLI_PIDFILE   hang and stray modes: write the pid of a grandchild process here
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const DEFAULT_ANSWER = 'From the lesson: see slide 2.\n[[general]]\nIn general, X is common.\n'

function chunks(text, size = 5) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const argValue = (args, name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function status(kind) {
  const loggedIn = process.env.FAKE_CLI_LOGGED_OUT !== '1'
  if (kind === 'claude') {
    line({ loggedIn, authMethod: 'claude.ai', email: 'learner@example.invalid', orgId: 'org-x' })
    process.exit(loggedIn ? 0 : 1)
  }
  line({
    status: loggedIn ? 'authenticated' : 'unauthenticated',
    isAuthenticated: loggedIn,
    userInfo: { email: 'learner@example.invalid' },
  })
  process.exit(0)
}

function log(kind, args, stdin) {
  const file = process.env.FAKE_CLI_LOG
  if (!file) return
  const systemPath = argValue(args, '--system-prompt-file')
  let system = null
  if (systemPath) {
    system = {
      path: systemPath,
      mode: statSync(systemPath).mode & 0o777,
      text: readFileSync(systemPath, 'utf8'),
    }
  }
  appendFileSync(
    file,
    JSON.stringify({
      kind,
      args,
      stdin,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      system,
      keyVars: Object.keys(process.env).filter((k) => /^(ANTHROPIC|ELEVENLABS)_/.test(k)),
      maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
      pid: process.pid,
    }) + '\n',
  )
}

export async function run(kind) {
  const args = process.argv.slice(2)
  if (kind === 'claude' && args[0] === 'auth' && args[1] === 'status') status(kind)
  if (kind === 'cursor' && args[0] === 'status') status(kind)
  if (!args.includes('-p')) {
    process.stderr.write('fake cli: interactive mode is not supported\n')
    process.exit(2)
  }
  // Like the real Claude Code CLI: stream-json output in print mode needs --verbose.
  if (kind === 'claude' && argValue(args, '--output-format') === 'stream-json') {
    if (!args.includes('--verbose')) {
      process.stderr.write(
        'Error: When using --print, --output-format=stream-json requires --verbose\n',
      )
      process.exit(1)
    }
  }
  const stdin = readFileSync(0, 'utf8')
  log(kind, args, stdin)
  const mode = process.env.FAKE_CLI_MODE ?? 'stream'
  const answer = process.env.FAKE_CLI_ANSWER ?? DEFAULT_ANSWER
  const model = argValue(args, '--model') ?? 'default'

  if (mode === 'stray') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    child.unref()
    if (process.env.FAKE_CLI_PIDFILE) writeFileSync(process.env.FAKE_CLI_PIDFILE, String(child.pid))
  }
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    if (process.env.FAKE_CLI_PIDFILE) writeFileSync(process.env.FAKE_CLI_PIDFILE, String(child.pid))
    setInterval(() => {}, 1000)
    return
  }
  if (mode === 'flood') {
    const big = JSON.stringify({ type: 'noise', pad: 'x'.repeat(8000) }) + '\n'
    for (let i = 0; i < 2000; i++) process.stdout.write(big)
    return
  }
  if (mode === 'fail') {
    process.stderr.write('fake cli: something broke\nsecond line\n')
    process.exit(3)
  }
  if (mode === 'not-logged-in') {
    if (kind === 'claude') {
      line({ type: 'system', subtype: 'init', model })
      line({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      })
    } else {
      process.stderr.write(
        "Error: Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY.\n",
      )
    }
    process.exit(1)
  }

  const usage = { input_tokens: 1200, output_tokens: 40 }
  if (kind === 'claude') {
    line({ type: 'system', subtype: 'init', model: `${model}-resolved`, tools: [] })
    if (mode === 'stream' || mode === 'stray') {
      line({ type: 'stream_event', event: { type: 'message_start' } })
      for (const text of chunks(answer)) {
        line({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        })
      }
    }
    if (mode !== 'whole') {
      line({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } })
    }
    line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: answer,
      stop_reason: 'end_turn',
      usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
    return
  }
  // cursor
  line({ type: 'system', subtype: 'init', model: `${model}-resolved`, session_id: 's1' })
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '…' }] } })
  if (mode === 'stream' || mode === 'stray') {
    for (const text of chunks(answer)) {
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        session_id: 's1',
        timestamp_ms: Date.now(),
      })
    }
  }
  if (mode !== 'whole') {
    // The buffered text again, without timestamp_ms (as the real CLI does).
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
      session_id: 's1',
    })
  }
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer,
    session_id: 's1',
    usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })
}
