import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJavaAnalyzer } from '../src/analyzers/java.js'
import { runContext } from '../src/commands/context.js'
import { runInit } from '../src/commands/init.js'
import { assertAudioNotCommittable } from '../src/commands/narrate.js'
import { childEnv } from '../src/lib/child-env.js'
import { assertGitVersion, parseGitVersion } from '../src/lib/git.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
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

  it('drops credential-looking extras whatever their position in the name', () => {
    const secret = [
      'VITE_ELEVENLABS_KEY',
      'SLIDEV_SECRET_KEY',
      'SLIDEV_PRIVATE_KEY',
      'VITE_DB_PASS',
      'VITE_TOKEN_VALUE',
      'VITE_CREDENTIALS_FILE',
      'SLIDEV_PWD',
      'VITE_APIKEY',
      'VITE_API_KEY',
      'VITE_DBPASSWORD',
    ]
    const fine = ['VITE_API_URL', 'SLIDEV_KEYMAP', 'VITE_PUBLIC_FLAG', 'VITE_BASE', 'SLIDEV_PORT']
    const env = childEnv({
      env: Object.fromEntries([...secret, ...fine].map((n) => [n, KEY])),
      extra: ['VITE_*', 'SLIDEV_*'],
    })
    for (const name of secret) expect(env, name).not.toHaveProperty(name)
    for (const name of fine) expect(env, name).toHaveProperty(name)
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

  it('course context reads the target without provider keys in git or jdeps environments', async () => {
    const bin = makeTempDir('tool-wrappers')
    const gitLog = path.join(bin, 'git-env.log')
    const jdepsLog = path.join(bin, 'jdeps-env.log')
    writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nenv >> ${JSON.stringify(gitLog)}\nPATH="\${PATH#*:}" exec git "$@"\n`,
    )
    writeFileSync(
      path.join(bin, 'jdeps'),
      `#!/bin/sh\n[ "$1" = "-version" ] && exit 0\nenv >> ${JSON.stringify(jdepsLog)}\n` +
        'echo "$(basename "$3") -> java.base"\n',
    )
    chmodSync(path.join(bin, 'git'), 0o755)
    chmodSync(path.join(bin, 'jdeps'), 0o755)

    const fx = await makeWorkspace()
    const keys = { ELEVENLABS_API_KEY: KEY, ANTHROPIC_API_KEY: `${KEY}-a`, NPM_TOKEN: `${KEY}-b` }
    const savedPath = process.env.PATH
    Object.assign(process.env, keys, { PATH: `${bin}${path.delimiter}${savedPath}` })
    try {
      await runContext({ lessonId: '01-placeholder', cwd: fx.workspace })
      // jdeps is only started for committed jars/classes: run the analyzer on one directly.
      await createJavaAnalyzer().analyze({
        pinnedCommit: 'x',
        selectedPaths: [],
        readText: () => null,
        artifacts: [{ path: 'lib/a.jar', size: 1, read: () => Buffer.from([1]) }],
      })
    } finally {
      process.env.PATH = savedPath
      for (const k of Object.keys(keys)) delete process.env[k]
    }
    for (const log of [gitLog, jdepsLog]) {
      const seen = readFileSync(log, 'utf8')
      expect(seen, log).toContain('PATH=')
      for (const [name, value] of Object.entries(keys)) {
        expect(seen, log).not.toContain(name)
        expect(seen, log).not.toContain(value)
      }
    }
  })

  it('the narration audio guard runs git without provider keys', async () => {
    const bin = makeTempDir('narrate-git-wrapper')
    const log = path.join(bin, 'env.log')
    writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nenv >> ${JSON.stringify(log)}\nPATH="\${PATH#*:}" exec git "$@"\n`,
    )
    chmodSync(path.join(bin, 'git'), 0o755)
    // A submodule-mode workspace is a git work tree, so the guard really runs git.
    const fx = await makeWorkspace(undefined, { submodule: true })
    const savedPath = process.env.PATH
    Object.assign(
      process.env,
      { ELEVENLABS_API_KEY: KEY },
      { PATH: `${bin}${path.delimiter}${savedPath}` },
    )
    try {
      assertAudioNotCommittable(fx.workspace, path.join(fx.workspace, 'audio', 'local', 'en', 'x'))
    } finally {
      process.env.PATH = savedPath
      delete process.env.ELEVENLABS_API_KEY
    }
    const seen = readFileSync(log, 'utf8')
    expect(seen).toContain('PATH=')
    expect(seen).not.toContain('ELEVENLABS_API_KEY')
    expect(seen).not.toContain(KEY)
  })

  it.each([
    ['git version 2.34.1', false],
    ['git version 2.37.9', false],
    ['git version 2.38.0', false],
    ['git version 2.42.9', false],
    ['git version 2.43.0', true],
    ['git version 2.43.0 (Apple Git-146)', true],
    ['git version 3.0.0', true],
    ['', false],
    ['something else', false],
  ])('git >= 2.43 check: %j -> %s', (output, ok) => {
    if (ok) expect(() => assertGitVersion(output)).not.toThrow()
    else expect(() => assertGitVersion(output)).toThrow(/needs git >= 2\.43/)
  })

  it('parses git version output', () => {
    expect(parseGitVersion('git version 2.43.0.windows.1\n')).toEqual([2, 43])
    expect(parseGitVersion('nope')).toBeNull()
  })
})
