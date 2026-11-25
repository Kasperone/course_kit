// Scenario: `course build` against a stand-in Slidev that hangs. argv: <workspace> <timeoutMs>.
// timeoutMs 0 disables the timeout (the negative control: the run never finishes).
import { runBuild } from '../../../src/commands/slidev.js'

const [workspace, timeoutMs] = process.argv.slice(2)
try {
  runBuild({ cwd: workspace!, timeoutMs: Number(timeoutMs) })
  console.log('RESULT: finished')
} catch (err) {
  console.log(`RESULT: ${(err as Error).message}`)
}
