import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A stand-in for @slidev/cli in the workspace's node_modules. It logs its argv to
 * slidev-calls.log in its cwd and, for `build`, writes <out>/index.html containing the deck source,
 * so tests can see what reached "Slidev" without installing it. It also logs to slidev-env.log
 * (one JSON object per call) which provider keys it can see, its whole environment and, when `course dev` passes COURSE_CHAT_PORT, the HTTP status
 * of the chat backend's status route while it runs.
 */
export function installFakeSlidev(workspace: string): string {
  const pkgDir = path.join(workspace, 'node_modules', '@slidev', 'cli')
  mkdirSync(path.join(pkgDir, 'bin'), { recursive: true })
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@slidev/cli', bin: { slidev: './bin/slidev.mjs' } }),
  )
  writeFileSync(
    path.join(pkgDir, 'bin', 'slidev.mjs'),
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
appendFileSync(path.join(process.cwd(), 'slidev-calls.log'), JSON.stringify(args) + '\\n')
const secrets = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ELEVENLABS_API_KEY'].filter((k) => process.env[k])
const port = process.env.COURSE_CHAT_PORT
let status = null
if (port && args[0] !== 'build') {
  const parts = args[0].split(path.sep)
  const lang = parts.at(-2)
  const lesson = parts.at(-3)
  const res = await fetch('http://127.0.0.1:' + port + '/@course-chat/v1/status?lesson=' + lesson + '&lang=' + lang)
  status = res.status
}
appendFileSync(path.join(process.cwd(), 'slidev-env.log'), JSON.stringify({ port: port ?? null, secrets, status, env: process.env }) + '\\n')
if (args[0] === 'build') {
  const out = args[args.indexOf('--out') + 1]
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'index.html'), '<html>' + readFileSync(args[1], 'utf8') + '</html>')
}
`,
  )
  return path.join(workspace, 'slidev-calls.log')
}
