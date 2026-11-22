// Scenario: one Piper synthesis against a fake piper that hangs. argv: <voicesDir> <timeoutMs>.
// timeoutMs 0 disables the timeout (the negative control: the run never finishes).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPiperProvider } from '../../../src/lib/narration/providers.js'
import { installPiperVoice } from '../../../src/lib/narration/voices.js'
import { fakeVoice } from '../fake-voice.js'

const [voicesDir, timeoutMs] = process.argv.slice(2)
const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const env: NodeJS.ProcessEnv = {
  COURSE_KIT_VOICES_DIR: voicesDir,
  PIPER_BIN: path.join(helpers, 'fake-piper.mjs'),
  FFMPEG_BIN: '/nonexistent/ffmpeg',
}
const v = fakeVoice('pl_PL-test-medium')
await installPiperVoice(v.info.name, { env, fetch: v.fetch, registry: [v.info] })
process.env.PIPER_FAKE_HANG = '1'
const provider = createPiperProvider({
  lang: 'pl',
  voice: 'pl_PL-test-medium',
  env,
  timeoutMs: Number(timeoutMs),
})
try {
  await provider.synthesize('x')
  console.log('RESULT: finished')
} catch (err) {
  console.log(`RESULT: ${(err as Error).message}`)
}
