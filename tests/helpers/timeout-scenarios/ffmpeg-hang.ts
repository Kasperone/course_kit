// Scenario: one WAV -> MP3 encode with an ffmpeg that hangs. argv: <timeoutMs>.
// timeoutMs 0 disables the timeout (the negative control: the run never finishes).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pcm16ToWav, wavToMp3 } from '../../../src/lib/narration/audio.js'

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const wav = pcm16ToWav(Buffer.alloc(3200), 16000)
try {
  wavToMp3(wav, path.join(helpers, 'fake-ffmpeg-hang.mjs'), 64, Number(process.argv[2]))
  console.log('RESULT: finished')
} catch (err) {
  console.log(`RESULT: ${(err as Error).message}`)
}
