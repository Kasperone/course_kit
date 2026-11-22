import { createHash } from 'node:crypto'
import type { PiperVoiceInfo } from '../../src/lib/narration/voices.js'

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** A registry entry whose files are served by a fake fetch. */
export function fakeVoice(name = 'pl_PL-test-medium') {
  const model = Buffer.from('fake onnx model')
  const config = Buffer.from(
    JSON.stringify({
      audio: { sample_rate: 16000 },
      inference: { noise_scale: 0.5, length_scale: 1, noise_w: 0.3 },
    }),
  )
  const card = Buffer.from('# Model card\n* License: CC0\n')
  const info: PiperVoiceInfo = {
    name,
    lang: name.slice(0, 2),
    repoPath: `x/${name}`,
    files: {
      model: { name: `${name}.onnx`, sha256: sha(model) },
      config: { name: `${name}.onnx.json`, sha256: sha(config) },
      card: { name: 'MODEL_CARD', sha256: sha(card) },
    },
    dataset: 'test',
    datasetLicense: 'CC0',
    training: 'test',
  }
  const bodies: Record<string, Buffer> = {
    [info.files.model.name]: model,
    [info.files.config.name]: config,
    MODEL_CARD: card,
  }
  const urls: string[] = []
  const fetch = (url: string) => {
    urls.push(url)
    const body = bodies[url.split('/').pop()!]
    return Promise.resolve(
      body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 }),
    )
  }
  return { info, fetch, urls, bodies }
}
