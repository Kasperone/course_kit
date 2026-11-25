import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export type BoundedRun = {
  /** True if the outer limit killed the run (the scenario hung). */
  hung: boolean
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/**
 * Run a scenario script (tests/helpers/timeout-scenarios/*.ts, via tsx) in its own process group
 * and kill the whole group after `outerMs`. Hang/timeout tests use this so that a removed or broken
 * timeout fails the test within a bounded time instead of freezing the suite (the code under test
 * blocks synchronously, so vitest's own test timeout could never fire). The same scenario with the
 * timeout disabled is the negative control: it must come back `hung`.
 */
export function runBounded(
  scenario: string,
  args: string[],
  outerMs: number,
  env: Record<string, string | undefined> = {},
): Promise<BoundedRun> {
  const script = path.join(repoRoot, 'tests', 'helpers', 'timeout-scenarios', `${scenario}.ts`)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    let hung = false
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      hung = true
      killGroup()
    }, outerMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      killGroup() // a surviving grandchild must not outlive the test
      resolve({ hung, code, stdout, stderr, ms: Date.now() - started })
    })
  })
}
