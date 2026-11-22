import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { childEnv } from '../src/lib/child-env.js'
import { assertGitVersion, parseGitVersion } from '../src/lib/git.js'
import { git, initRepoWithCommit } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

// Fake secrets, assembled at runtime so the repo itself never contains key-shaped strings.
const KEY = ['fake', 'key', '123456'].join('-')

describe('childEnv', () => {
  it('passes what tools need to run and drops everything else, secrets included', () => {
    const env = childEnv({
      env: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        TMPDIR: '/tmp',
        SSH_AUTH_SOCK: '/run/agent',
        https_proxy: 'http://proxy:3128',
        ELEVENLABS_API_KEY: KEY,
        ANTHROPIC_API_KEY: KEY,
        GITHUB_TOKEN: KEY,
        AWS_SECRET_ACCESS_KEY: KEY,
        DB_PASSWORD: KEY,
        SOME_UNRELATED: 'x',
      },
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TMPDIR: '/tmp',
      SSH_AUTH_SOCK: '/run/agent',
      https_proxy: 'http://proxy:3128',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  it('keeps extra names and prefixes, but never credential-looking ones', () => {
    const env = childEnv({
      env: {
        NODE_OPTIONS: '--no-warnings',
        NODE_AUTH_TOKEN: KEY,
        npm_config_cache: '/c',
        OTHER: '1',
      },
      extra: ['NODE_*', 'NPM_CONFIG_CACHE'],
    })
    expect(Object.keys(env).sort()).toEqual([
      'GIT_TERMINAL_PROMPT',
      'NODE_OPTIONS',
      'npm_config_cache',
    ])
  })

  it('matches names case-insensitively (Windows) and keeps the original spelling', () => {
    expect(childEnv({ env: { Path: 'C:\\bin', SystemRoot: 'C:\\Windows' } })).toMatchObject({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
    })
  })

  it('never lets git prompt for credentials', () => {
    expect(childEnv({ env: { GIT_TERMINAL_PROMPT: '1' } }).GIT_TERMINAL_PROMPT).toBe('0')
  })
})

describe('git child processes', () => {
  it('course init runs git without provider keys or other secrets in its environment', async () => {
    const bin = makeTempDir('git-wrapper')
    const log = path.join(bin, 'env.log')
    // Records each git call's environment, then runs the real git (next on PATH).
    writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nenv >> ${JSON.stringify(log)}\nPATH="\${PATH#*:}" exec git "$@"\n`,
    )
    chmodSync(path.join(bin, 'git'), 0o755)

    // The fixture is built first: the test helpers run git with the full environment.
    const root = makeTempDir('init-env')
    const repoDir = path.join(root, 'target')
    const pinned = initRepoWithCommit(repoDir)
    git(repoDir, ['remote', 'add', 'origin', 'https://git.example/acme/app.git'])
    git(repoDir, ['update-ref', 'refs/remotes/origin/main', pinned])

    const keys = {
      ELEVENLABS_API_KEY: KEY,
      ANTHROPIC_API_KEY: `${KEY}-a`,
      GITHUB_TOKEN: `${KEY}-b`,
    }
    const savedPath = process.env.PATH
    Object.assign(process.env, keys, { PATH: `${bin}${path.delimiter}${savedPath}` })
    try {
      await runInit({
        targetRepo: repoDir,
        outDir: path.join(root, 'ws'),
        languages: ['en'],
        submodule: true,
      })
    } finally {
      process.env.PATH = savedPath
      for (const k of Object.keys(keys)) delete process.env[k]
    }
    const seen = readFileSync(log, 'utf8')
    // submodule mode makes the most git calls: toplevel, HEAD, status, remote, init, submodule...
    expect(seen.split('PATH=').length).toBeGreaterThan(6)
    expect(seen).toContain('GIT_TERMINAL_PROMPT=0')
    for (const [name, value] of Object.entries(keys)) {
      expect(seen).not.toContain(name)
      expect(seen).not.toContain(value)
    }
  })

  it.each([
    ['git version 2.34.1', false],
    ['git version 2.37.9', false],
    ['git version 2.38.0', true],
    ['git version 2.43.0 (Apple Git-146)', true],
    ['git version 3.0.0', true],
    ['', false],
    ['something else', false],
  ])('git >= 2.38 check: %j -> %s', (output, ok) => {
    if (ok) expect(() => assertGitVersion(output)).not.toThrow()
    else expect(() => assertGitVersion(output)).toThrow(/needs git >= 2\.38/)
  })

  it('parses git version output', () => {
    expect(parseGitVersion('git version 2.43.0.windows.1\n')).toEqual([2, 43])
    expect(parseGitVersion('nope')).toBeNull()
  })
})
