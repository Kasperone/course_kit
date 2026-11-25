import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A stand-in for @slidev/cli in the workspace's node_modules. It logs its argv to
 * slidev-calls.log and its environment to slidev-env.log (one JSON object per call) in its cwd and, for `build`, writes <out>/index.html containing the deck source,
 * so tests can see what reached "Slidev" without installing it. A `slidev-hang` file in the workspace makes it hang.
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
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
appendFileSync(path.join(process.cwd(), 'slidev-calls.log'), JSON.stringify(args) + '\\n')
appendFileSync(path.join(process.cwd(), 'slidev-env.log'), JSON.stringify(process.env) + '\\n')
// A file named slidev-hang in the workspace makes the stand-in hang (build timeout test).
if (existsSync(path.join(process.cwd(), 'slidev-hang'))) setInterval(() => {}, 1000)
if (args[0] === 'build' && !existsSync(path.join(process.cwd(), 'slidev-hang'))) {
  const out = args[args.indexOf('--out') + 1]
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'index.html'), '<html>' + readFileSync(args[1], 'utf8') + '</html>')
}
`,
  )
  return path.join(workspace, 'slidev-calls.log')
}
