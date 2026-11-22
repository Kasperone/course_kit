import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAsk, renderParts } from '../src/commands/ask.js'
import { runServe, type ServeResult } from '../src/commands/serve.js'
import { runBuild, runDev } from '../src/commands/slidev.js'
import { deckFrontmatter, findForbiddenBuildRefs } from '../src/lib/slidev.js'
import { chatWorkspace, fakeProvider, raw } from './helpers/chat.js'
import { installFakeSlidev } from './helpers/fake-slidev.js'
import { makeWorkspace } from './helpers/fixture-repo.js'

const KEY = 'sk-ant-cli-test-key-000000000001'

let served: ServeResult | undefined
afterEach(async () => {
  await served?.close()
  served = undefined
})

const envLog = (ws: string) =>
  readFileSync(path.join(ws, 'slidev-env.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      // The fake also logs its whole environment (checked in slidev.test.ts); only the chat fields here.
      const { port, secrets, status } = JSON.parse(l) as {
        port: string | null
        secrets: string[]
        status: number | null
      }
      return { port, secrets, status }
    })

describe('course serve', () => {
  it('needs a built course, then serves dist/ and the API on 127.0.0.1', async () => {
    const { ws } = chatWorkspace()
    rmSync(path.join(ws, 'dist', 'index.html'))
    await expect(runServe({ cwd: ws, port: 0, env: {} })).rejects.toThrow(/Run `course build`/)
    writeFileSync(path.join(ws, 'dist', 'index.html'), '<html>index</html>')

    served = await runServe({ cwd: ws, port: 0, env: {} })
    expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(served.chat).toMatchObject({
      enabled: true,
      provider: 'anthropic-api',
      model: 'claude-sonnet-5-5',
      billing: 'api',
      availability: { state: 'no-key' },
    })
    expect((await raw(served.port, { path: '/' })).body).toBe('<html>index</html>')
    const st = await raw(served.port, { path: '/@course-chat/v1/status?lesson=01-x&lang=en' })
    expect(JSON.parse(st.body)).toMatchObject({ answers: 'no-key', model: 'claude-sonnet-5-5' })
  })

  it('--model and --no-chat; key from the workspace .env', async () => {
    const { ws } = chatWorkspace()
    writeFileSync(path.join(ws, '.env'), `ANTHROPIC_API_KEY=${KEY}\n`)
    served = await runServe({ cwd: ws, port: 0, model: 'claude-haiku-5-5', env: {} })
    expect(served.chat).toEqual({
      enabled: true,
      provider: 'anthropic-api',
      model: 'claude-haiku-5-5',
      billing: 'api',
      availability: { state: 'ready', message: null },
    })
    await served.close()
    served = await runServe({ cwd: ws, port: 0, chat: false, env: {} })
    const st = await raw(served.port, { path: '/@course-chat/v1/status' })
    expect(JSON.parse(st.body)).toMatchObject({ answers: 'disabled' })
    expect(st.body).not.toContain(KEY)
  })

  it('refuses a symlinked dist/index.html', async () => {
    const { ws } = chatWorkspace()
    rmSync(path.join(ws, 'dist', 'index.html'))
    writeFileSync(path.join(ws, 'elsewhere.html'), 'x')
    symlinkSync(path.join(ws, 'elsewhere.html'), path.join(ws, 'dist', 'index.html'))
    await expect(runServe({ cwd: ws, port: 0, env: {} })).rejects.toThrow(/symlink/i)
  })
})

describe('course ask', () => {
  it('--dry-run reports sizes and cost without a key or network', async () => {
    const { ws } = chatWorkspace()
    const lines: string[] = []
    const r = await runAsk({
      lessonId: '01-x',
      cwd: ws,
      dryRun: true,
      env: {},
      log: (l) => lines.push(l),
    })
    expect(r.systemTokens).toBeGreaterThan(500)
    expect(lines.join('\n')).toMatch(/Context pack: ok/)
    expect(lines.join('\n')).toMatch(/claude-sonnet-5-5, effort low; est\. per question/)
  })

  it('--dry-run on a workspace without a pack says what is missing', async () => {
    const { workspace } = await makeWorkspace()
    const lines: string[] = []
    await runAsk({
      lessonId: '01-placeholder',
      cwd: workspace,
      dryRun: true,
      env: {},
      log: (l) => lines.push(l),
    })
    expect(lines.join('\n')).toMatch(/Not ready: No context pack .*course context 01-placeholder/)
  })

  it('streams the answer with visible source labels', async () => {
    const { ws } = chatWorkspace()
    const fake = fakeProvider([
      { deltas: ['See slide 2.\n[[general]]\nIn general X.\n[[lesson]]\nBack.'] },
    ])
    let out = ''
    const r = await runAsk({
      lessonId: '01-x',
      question: 'What is X?',
      cwd: ws,
      lang: 'pl',
      answerProvider: fake.provider,
      write: (t) => (out += t),
      log: () => {},
    })
    expect(out).toBe(
      'See slide 2.\n\n[not from this lesson]\nIn general X.\n\n[from the lesson]\nBack.\n',
    )
    expect(r.stopReason).toBe('end_turn')
    expect(fake.calls[0]!.req.system[0]!.text).toContain('Always answer in Polish')
    expect(renderParts([{ type: 'off-topic' }], { source: 'lesson' })).toBe('[off-topic] ')
  })

  it('without a key it fails with a clear message', async () => {
    const { ws } = chatWorkspace()
    await expect(runAsk({ lessonId: '01-x', question: 'q', cwd: ws, env: {} })).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set/,
    )
  })
})

describe('course dev with the chat backend', () => {
  it('runs the backend during the dev server and keeps keys away from Slidev', async () => {
    const { workspace } = await makeWorkspace()
    installFakeSlidev(workspace)
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = KEY
    try {
      const logs: string[] = []
      expect(
        await runDev({ lesson: '01-placeholder', cwd: workspace, log: (l) => logs.push(l) }),
      ).toBe(0)
      const [run] = envLog(workspace)
      expect(run!.port).toMatch(/^\d+$/)
      expect(run!.secrets).toEqual([])
      // The backend answered while Slidev ran (status for this lesson/lang).
      expect(run!.status).toBe(200)
      expect(logs.join('\n')).toMatch(
        /Q&A backend on http:\/\/127\.0\.0\.1:\d+ · anthropic-api \(claude-sonnet-5-5; API key, cached prompt\)/,
      )
      expect(logs.join('\n')).not.toContain(KEY)

      expect(await runDev({ lesson: '01-placeholder', cwd: workspace, chat: false })).toBe(0)
      expect(envLog(workspace)[1]).toEqual({ port: null, secrets: [], status: null })
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

describe('course build: provider hosts and keys never reach the deck', () => {
  it('fails when the built output contains an API key or a provider API host', async () => {
    const { workspace } = await makeWorkspace(undefined, { languages: ['en'] })
    installFakeSlidev(workspace)
    writeFileSync(path.join(workspace, '.env'), `ANTHROPIC_API_KEY=${KEY}\n`)
    const file = path.join(workspace, 'lessons', '01-placeholder', 'en', 'slides.md')
    const head = deckFrontmatter({ title: 'x', lang: 'en' })
    // The fake build copies the deck into index.html, as a leaked key would appear.
    writeFileSync(file, `${head}\n# x\n\n<!-- ${KEY} -->\n`)
    let message = ''
    try {
      runBuild({ cwd: workspace })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/Built output contains an API key.*index\.html/)
    expect(message).not.toContain(KEY)
    expect(envLog(workspace)[0]!.secrets).toEqual([])

    writeFileSync(file, `${head}\n# x\n\n<!-- api.anthropic.com -->\n`)
    expect(() => runBuild({ cwd: workspace })).toThrow(/index\.html \(provider API\)/)
    expect(findForbiddenBuildRefs(path.join(workspace, 'dist'))[0]!.what).toBe('provider API')
    expect(existsSync(path.join(workspace, 'dist'))).toBe(true)
  })
})
