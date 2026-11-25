import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPin } from '../src/commands/pin.js'
import {
  CHAT_DEFAULTS,
  CHAT_MODEL_ENV,
  CHAT_PROVIDER_ENV,
  DEFAULT_CHAT_MODEL,
  DEFAULT_MODELS,
  parseChatSettings,
  resolveChatConfig,
} from '../src/lib/chat/config.js'
import { childEnv } from '../src/lib/child-env.js'
import { readWorkspaceSecret, redactSecrets } from '../src/lib/env.js'
import { parseCourseJson } from '../src/lib/workspace.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { commitAll, writeFiles } from './helpers/git.js'
import { makeTempDir } from './helpers/tmp.js'

const base = {
  schemaVersion: 1,
  targetRepo: null,
  pinnedCommit: 'a'.repeat(40),
  languages: ['en'],
}

describe('course.json chat', () => {
  it('is optional; defaults use Sonnet 5.5 at low effort', () => {
    expect(parseCourseJson(base, 'course.json').chat).toBeUndefined()
    const cfg = resolveChatConfig(undefined, {}, {})
    expect(cfg.model).toBe(DEFAULT_CHAT_MODEL)
    expect(DEFAULT_CHAT_MODEL).toBe('claude-sonnet-5-5')
    expect(cfg).toMatchObject({
      effort: 'low',
      port: 8787,
      refusalFallback: true,
      rateLimit: { perMinute: 6, perDay: 200, concurrent: 1 },
      maxAudioSeconds: 60,
    })
  })

  it('validates every field and rejects unknown ones', () => {
    const ok = {
      enabled: true,
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxOutputTokens: 4000,
      maxPackTokens: 80000,
      historyTurns: 4,
      cacheTtl: '1h',
      refusalFallback: false,
      rateLimit: { perMinute: 3, perDay: 50, concurrent: 2 },
      port: 9000,
      stt: { provider: 'off', model: 'small' },
    }
    expect(parseCourseJson({ ...base, chat: ok }, 'course.json').chat).toEqual(ok)
    const bad: Array<[unknown, RegExp]> = [
      ['x', /must be an object/],
      [{ model: 'gpt-4' }, /Claude model id/],
      [{ model: 'claude-x/../v1' }, /Claude model id/],
      [{ effort: 'extreme' }, /effort must be one of/],
      [{ maxOutputTokens: 10 }, /maxOutputTokens must be an integer/],
      [{ cacheTtl: '2h' }, /cacheTtl must be one of/],
      [{ port: 80 }, /port must be an integer from 1024/],
      [{ rateLimit: { perMinute: 0 } }, /perMinute/],
      [{ rateLimit: { burst: 1 } }, /unknown field "burst"/],
      [{ stt: { provider: 'cloud' } }, /stt.provider must be one of/],
      [{ stt: { model: '../x' } }, /stt.model/],
      [{ outOfScope: 'refuse' }, /unknown field "outOfScope"/],
    ]
    for (const [chat, re] of bad) {
      expect(() => parseCourseJson({ ...base, chat }, 'course.json')).toThrow(re)
    }
    expect(() => parseChatSettings({ enabled: 'yes' }, 'chat')).toThrow(/true or false/)
  })

  it('model precedence: flag > COURSE_CHAT_MODEL > course.json > default', () => {
    const s = { model: 'claude-opus-5-5' }
    expect(resolveChatConfig(s, {}, {}).model).toBe('claude-opus-5-5')
    expect(resolveChatConfig(s, {}, { [CHAT_MODEL_ENV]: 'claude-haiku-5-5' }).model).toBe(
      'claude-haiku-5-5',
    )
    expect(
      resolveChatConfig(s, { model: 'claude-sonnet-5-5' }, { [CHAT_MODEL_ENV]: 'claude-haiku-5-5' })
        .model,
    ).toBe('claude-sonnet-5-5')
    expect(() => resolveChatConfig(s, {}, { [CHAT_MODEL_ENV]: 'nope' })).toThrow(CHAT_MODEL_ENV)
    expect(() => resolveChatConfig(s, { model: 'x' })).toThrow(/--model/)
    expect(resolveChatConfig({ port: 9100 }, { port: 9200 }, {}).port).toBe(9200)
    expect(CHAT_DEFAULTS.model).toBe(DEFAULT_CHAT_MODEL)
  })

  it('provider precedence: flag > COURSE_CHAT_PROVIDER > course.json > anthropic-api', () => {
    expect(resolveChatConfig(undefined, {}, {}).provider).toBe('anthropic-api')
    const s = { provider: 'claude-cli' as const }
    expect(resolveChatConfig(s, {}, {}).provider).toBe('claude-cli')
    expect(resolveChatConfig(s, {}, { [CHAT_PROVIDER_ENV]: 'cursor-cli' }).provider).toBe(
      'cursor-cli',
    )
    expect(
      resolveChatConfig(s, { provider: 'anthropic-api' }, { [CHAT_PROVIDER_ENV]: 'cursor-cli' })
        .provider,
    ).toBe('anthropic-api')
    expect(() => resolveChatConfig(s, {}, { [CHAT_PROVIDER_ENV]: 'openai' })).toThrow(
      CHAT_PROVIDER_ENV,
    )
    expect(() => resolveChatConfig(s, { provider: 'claude' }, {})).toThrow(/--provider/)
  })

  it('each provider has its own model and default; flag and env apply to the selected one', () => {
    expect(DEFAULT_MODELS).toEqual({
      'anthropic-api': 'claude-sonnet-5-5',
      'claude-cli': 'sonnet',
      'cursor-cli': 'claude-sonnet-5-5-low',
    })
    const s = {
      model: 'claude-opus-5-5',
      claudeCli: { model: 'opus', timeoutSeconds: 300 },
      cursorCli: { model: 'claude-opus-5-5-high' },
    }
    expect(resolveChatConfig(s, {}, {})).toMatchObject({ model: 'claude-opus-5-5' })
    expect(resolveChatConfig(s, { provider: 'claude-cli' }, {})).toMatchObject({
      model: 'opus',
      cliTimeoutMs: 300_000,
    })
    expect(resolveChatConfig(s, { provider: 'cursor-cli' }, {})).toMatchObject({
      model: 'claude-opus-5-5-high',
      cliTimeoutMs: 180_000,
    })
    expect(resolveChatConfig({}, { provider: 'claude-cli' }, {}).model).toBe('sonnet')
    expect(resolveChatConfig({}, { provider: 'cursor-cli' }, {}).model).toBe(
      'claude-sonnet-5-5-low',
    )
    expect(
      resolveChatConfig(s, { provider: 'claude-cli' }, { [CHAT_MODEL_ENV]: 'haiku' }).model,
    ).toBe('haiku')
    expect(
      resolveChatConfig(
        s,
        { provider: 'claude-cli', model: 'claude-sonnet-5-5[1m]' },
        { [CHAT_MODEL_ENV]: 'haiku' },
      ).model,
    ).toBe('claude-sonnet-5-5[1m]')
    expect(
      resolveChatConfig(s, {
        provider: 'cursor-cli',
        model: 'claude-opus-4-8[context=1m,effort=high]',
      }).model,
    ).toBe('claude-opus-4-8[context=1m,effort=high]')
    // CLI model names are arguments: nothing option-like, no spaces or shell characters.
    for (const bad of ['--dangerously-skip-permissions', '-f', 'sonnet; rm -rf ~', '$(id)', ''])
      expect(() => resolveChatConfig({}, { provider: 'claude-cli', model: bad }, {})).toThrow(
        /--model must be a claude-cli model/,
      )
    expect(() => resolveChatConfig({}, { provider: 'cursor-cli', model: '--yolo' }, {})).toThrow(
      /cursor-cli model/,
    )
    // The API provider still takes Claude API ids only.
    expect(() => resolveChatConfig({}, { model: 'sonnet' }, {})).toThrow(/Claude model id/)
  })

  it('validates the provider blocks', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ provider: 'gpt' }, /provider must be one of: anthropic-api, claude-cli, cursor-cli/],
      [{ claudeCli: 'x' }, /claudeCli must be an object/],
      [{ claudeCli: { model: '-p' } }, /claudeCli\.model must be a claude-cli model/],
      [{ cursorCli: { timeoutSeconds: 5 } }, /timeoutSeconds must be an integer from 10 to 900/],
      [{ cursorCli: { bin: '/usr/bin/x' } }, /unknown field "bin"/],
    ]
    for (const [chat, re] of bad) {
      expect(() => parseCourseJson({ ...base, chat }, 'course.json'), JSON.stringify(chat)).toThrow(
        re,
      )
    }
  })

  it('survives course pin', async () => {
    const fx = await makeWorkspace()
    const file = path.join(fx.workspace, 'course.json')
    const chat = {
      model: 'claude-haiku-5-5',
      provider: 'cursor-cli',
      claudeCli: { model: 'opus' },
      cursorCli: { model: 'claude-sonnet-5-5-medium', timeoutSeconds: 240 },
      rateLimit: { perDay: 20 },
    }
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), chat }))
    writeFiles(fx.repoDir, { 'NEW.md': 'x\n' })
    commitAll(fx.repoDir, 'second')
    runPin({ cwd: fx.workspace })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ chat })
  })
})

describe('workspace secrets', () => {
  it('come from the environment, else the workspace .env', () => {
    const dir = makeTempDir('secret')
    expect(readWorkspaceSecret(dir, 'ANTHROPIC_API_KEY', {})).toBeNull()
    writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=\nELEVENLABS_API_KEY=\n')
    expect(readWorkspaceSecret(dir, 'ANTHROPIC_API_KEY', {})).toBeNull()
    writeFileSync(path.join(dir, '.env'), "# x\nexport ANTHROPIC_API_KEY='sk-ant-file'\n")
    expect(readWorkspaceSecret(dir, 'ANTHROPIC_API_KEY', {})).toBe('sk-ant-file')
    expect(readWorkspaceSecret(dir, 'ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'sk-env' })).toBe(
      'sk-env',
    )
    expect(() => readWorkspaceSecret(dir, 'A.*', {})).toThrow(/Invalid variable name/)
  })

  it('redactSecrets also drops the password of a proxy URL', () => {
    expect(redactSecrets('via http://u:s3cr3t@proxy:3128 with key sk-1', ['sk-1'])).toBe(
      'via http://u:‹redacted›@proxy:3128 with key ‹redacted›',
    )
  })

  it('are redacted and never passed on to child processes', () => {
    expect(redactSecrets('key sk-1 and sk-1 again', ['sk-1', null])).toBe(
      'key ‹redacted› and ‹redacted› again',
    )
    const env = childEnv({
      env: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'a',
        ANTHROPIC_AUTH_TOKEN: 'c',
        ELEVENLABS_API_KEY: 'b',
      },
    })
    expect(env).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0' })
  })
})
