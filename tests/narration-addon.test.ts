import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createPlayGeneration,
  playFailure,
} from '../templates/workspace/addons/narration/playback.js'
import { resolveDevClip } from '../templates/workspace/addons/narration/setup/vite-plugins.js'
import { makeTempDir } from './helpers/tmp.js'

const named = (name: string) => Object.assign(new Error(name), { name })

describe('player: what a rejected play() does', () => {
  it('ignores AbortError (a newer src or pause interrupted it), so quick navigation keeps narration on', () => {
    expect(playFailure(named('AbortError'))).toBe('ignore')
  })

  it('switches narration off only when the browser refuses to play', () => {
    expect(playFailure(named('NotAllowedError'))).toBe('off')
    expect(playFailure(named('NotSupportedError'))).toBe('off')
  })

  it('stays on, quietly, for any other failure', () => {
    expect(playFailure(named('EncodingError'))).toBe('quiet')
    expect(playFailure(new Error('x'))).toBe('quiet')
    expect(playFailure(undefined)).toBe('quiet')
    expect(playFailure('string')).toBe('quiet')
  })

  it('marks a play request stale once a newer play or a stop began', () => {
    const gen = createPlayGeneration()
    const first = gen.begin()
    expect(gen.isCurrent(first)).toBe(true)
    const second = gen.begin() // "next" pressed again
    expect(gen.isCurrent(first)).toBe(false)
    expect(gen.isCurrent(second)).toBe(true)
    gen.begin() // stop()
    expect(gen.isCurrent(second)).toBe(false)
  })
})

describe('dev server: which clip a request may read', () => {
  const FILE = 's01-c00-0123456789ab.mp3'

  function workspace() {
    const ws = makeTempDir('addon-dev')
    const dir = path.join(ws, 'audio', 'local', 'en', '01-intro')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, FILE), 'x')
    writeFileSync(path.join(dir, 'manifest.json'), '{}')
    return { ws, dir, where: { ws, lesson: '01-intro' } }
  }

  it('serves the manifest and clips written by `course narrate`', () => {
    const { dir, where } = workspace()
    expect(resolveDevClip(where, ['en', 'pl'], `/en/${FILE}`)).toBe(path.join(dir, FILE))
    expect(resolveDevClip(where, ['en'], '/en/manifest.json?t=1')).toBe(
      path.join(dir, 'manifest.json'),
    )
  })

  it.each([
    ['a malformed escape (was a 500)', '/en/%E0%A4%A'],
    ['an unknown language', `/de/${FILE}`],
    ['a name course narrate never writes', '/en/secret.txt'],
    ['a traversal', '/en/../../x.mp3'],
    ['a missing clip', '/en/s02-c00-0123456789ab.mp3'],
    ['an extra path segment', `/en/x/${FILE}`],
  ])('answers 404 for %s', (_what, url) => {
    const { where } = workspace()
    expect(resolveDevClip(where, ['en'], url)).toBeNull()
  })

  it('refuses a symlinked clip and a symlinked lesson directory', () => {
    const { ws, dir, where } = workspace()
    const outside = makeTempDir('addon-outside')
    writeFileSync(path.join(outside, FILE), 'secret')
    symlinkSync(path.join(outside, FILE), path.join(dir, 's03-c00-0123456789ab.mp3'))
    expect(resolveDevClip(where, ['en'], '/en/s03-c00-0123456789ab.mp3')).toBeNull()

    // audio/local/pl/01-intro -> outside: the file itself is a regular file, the directory is not.
    mkdirSync(path.join(ws, 'audio', 'local', 'pl'), { recursive: true })
    symlinkSync(outside, path.join(ws, 'audio', 'local', 'pl', '01-intro'))
    expect(resolveDevClip(where, ['en', 'pl'], `/pl/${FILE}`)).toBeNull()
  })
})
