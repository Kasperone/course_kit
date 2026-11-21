import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveChatConfig } from '../lib/chat/config.js'
import type { AnswerProvider } from '../lib/chat/provider.js'
import { describeChat, type ChatSummary } from '../lib/chat/providers.js'
import { startChatServer, type ChatServer } from '../lib/chat/server.js'
import { assertNoSymlinkBelow } from '../lib/fs-safe.js'
import { resolveWorkspaceConfig } from '../lib/workspace.js'
import { BUILD_DIR } from './slidev.js'

export type ServeOptions = {
  cwd?: string
  /** Port on 127.0.0.1 (default: course.json chat.port, else 8787; 0 picks a free one). */
  port?: number
  /** Chat model override (--model). */
  model?: string
  /** Chat provider override (--provider). */
  provider?: string
  /** false: serve the decks without the Q&A API (--no-chat). */
  chat?: boolean
  env?: NodeJS.ProcessEnv
  answerProvider?: AnswerProvider
  log?: (line: string) => void
  /** CLI providers: root for their private temp directories. */
  tmpDir?: string
}

export type ServeResult = ChatServer & {
  courseDir: string
  distDir: string
  chat: ChatSummary
}

export { describeChat }

/**
 * `course serve`: one local origin (127.0.0.1 only) for the built course: dist/ (decks, narration)
 * plus the Q&A API under /@course-chat/v1/. API keys stay in this process.
 */
export async function runServe(options: ServeOptions = {}): Promise<ServeResult> {
  const { courseDir, course } = resolveWorkspaceConfig(options.cwd)
  const env = options.env ?? process.env
  const distDir = path.join(courseDir, BUILD_DIR)
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`No built course in ${distDir}. Run \`course build\` first.`)
  }
  assertNoSymlinkBelow(courseDir, path.join(distDir, 'index.html'), 'Build output')
  const chat = resolveChatConfig(
    course.chat,
    { model: options.model, port: options.port, provider: options.provider },
    env,
  )
  const enabled = options.chat !== false && chat.enabled
  const server = await startChatServer({
    courseDir,
    port: chat.port,
    chat: enabled ? chat : null,
    staticDir: distDir,
    provider: options.answerProvider,
    env,
    log: options.log,
    tmpDir: options.tmpDir,
  })
  const summary = await server.summary()
  return {
    ...server,
    courseDir,
    distDir,
    chat: summary ?? {
      enabled: false,
      provider: chat.provider,
      model: chat.model,
      billing: 'api',
      availability: { state: 'ready', message: null },
    },
  }
}
