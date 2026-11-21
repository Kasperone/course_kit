import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPin } from '../src/commands/pin.js'
import {
  CHAT_DEFAULTS,
  CHAT_MODEL_ENV,
  DEFAULT_CHAT_MODEL,
  parseChatSettings,
  resolveChatConfig,
} from '../src/lib/chat/config.js'
import { readWorkspaceSecret, redactSecrets, withoutSecrets } from '../src/lib/env.js'
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

  it('survives course pin', async () => {
    const fx = await makeWorkspace()
    const file = path.join(fx.workspace, 'course.json')
    const chat = { model: 'claude-haiku-5-5', rateLimit: { perDay: 20 } }
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

  it('are redacted and never passed on to child processes', () => {
    expect(redactSecrets('key sk-1 and sk-1 again', ['sk-1', null])).toBe(
      'key ‹redacted› and ‹redacted› again',
    )
    const env = withoutSecrets({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', ELEVENLABS_API_KEY: 'b' })
    expect(env).toEqual({ PATH: '/bin' })
  })
})
