import { ANTHROPIC_KEY_ENV, resolveChatConfig } from '../lib/chat/config.js'
import { loadLessonMaterials } from '../lib/chat/materials.js'
import {
  buildMessages,
  buildSystem,
  materialsProblem,
  parseAskRequest,
  promptBudget,
  SourceSplitter,
  type AnswerPart,
} from '../lib/chat/prompt.js'
import {
  createAnthropicProvider,
  estimateCost,
  type AnswerProvider,
  type AnswerUsage,
} from '../lib/chat/provider.js'
import { readWorkspaceSecret } from '../lib/env.js'
import { resolveWorkspaceConfig } from '../lib/workspace.js'
import path from 'node:path'

export type AskOptions = {
  lessonId: string
  question?: string
  cwd?: string
  lang?: string
  slide?: number
  click?: number
  model?: string
  /** Print prompt sizes and a cost estimate; no API call, no key needed. */
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  provider?: AnswerProvider
  write?: (text: string) => void
  log?: (line: string) => void
}

export type AskResult = {
  model: string
  systemTokens: number
  totalTokens: number
  usage: AnswerUsage | null
  stopReason: string | null
}

/** Answer text for a terminal: source changes become visible labels. */
export function renderParts(parts: AnswerPart[], state: { source: string }): string {
  let out = ''
  for (const p of parts) {
    if (p.type === 'off-topic') {
      out += '[off-topic] '
      continue
    }
    if (p.source !== state.source) {
      out += p.source === 'general' ? '\n[not from this lesson]\n' : '\n[from the lesson]\n'
      state.source = p.source
    }
    out += p.text
  }
  return out
}

/**
 * `course ask`: the chat pipeline in the terminal (same materials, prompt and model as the deck
 * panel). With --dry-run it only reports prompt sizes, the budget check and a cost estimate.
 */
export async function runAsk(options: AskOptions): Promise<AskResult> {
  const { courseDir, course } = resolveWorkspaceConfig(options.cwd)
  const env = options.env ?? process.env
  const write = options.write ?? ((t: string) => process.stdout.write(t))
  const log = options.log ?? ((l: string) => console.error(l))
  const chat = resolveChatConfig(course.chat, { model: options.model }, env)
  const lang = options.lang ?? course.languages[0]!
  const materials = loadLessonMaterials(
    courseDir,
    course,
    options.lessonId,
    lang,
    chat.maxPackTokens,
  )
  const req = parseAskRequest(
    {
      lesson: options.lessonId,
      lang,
      slide: options.slide ?? 1,
      click: options.click ?? 0,
      question: options.question ?? (options.dryRun ? '(dry run)' : ''),
    },
    chat,
  )
  if (req.slide > materials.slides.length) {
    throw new Error(`--slide must be from 1 to ${materials.slides.length}`)
  }
  const ctx = {
    repoName:
      path
        .basename((course.targetRemote ?? course.targetRepo ?? '').replace(/\/+$/, ''))
        .replace(/\.git$/, '') || 'the target repository',
    pinnedCommit: course.pinnedCommit,
  }
  const system = buildSystem(materials, ctx, chat.cacheTtl)
  const messages = buildMessages(req, materials, chat.historyTurns)
  const budget = promptBudget(system, messages)
  const problem = materialsProblem(materials, chat)

  if (options.dryRun) {
    const pack = materials.pack
    log(
      `Lesson: ${materials.lessonId}/${lang} "${materials.title}" (${materials.slides.length} slides)`,
    )
    log(
      `Context pack: ${pack.status}${pack.commit ? ` (commit ${pack.commit.slice(0, 12)})` : ''}, ~${pack.tokens} tokens`,
    )
    log(`Slides and notes: ~${materials.slidesTokens} tokens`)
    log(
      `Prompt: ~${budget.systemTokens} cached + ~${budget.messageTokens} per question (cap ${chat.maxPromptTokens})`,
    )
    const cost = estimateCost(
      chat.model,
      budget.systemTokens,
      budget.messageTokens,
      1000,
      chat.cacheTtl,
    )
    log(
      `Model: ${chat.model}, effort ${chat.effort}` +
        (cost
          ? `; est. per question with ~1k output: $${cost.cold.toFixed(3)} cold, $${cost.warm.toFixed(3)} cached`
          : ''),
    )
    if (problem) log(`Not ready: ${problem.message}`)
    return {
      model: chat.model,
      systemTokens: budget.systemTokens,
      totalTokens: budget.totalTokens,
      usage: null,
      stopReason: null,
    }
  }

  if (problem) throw new Error(problem.message)
  if (budget.totalTokens > chat.maxPromptTokens) {
    throw new Error(`The prompt (~${budget.totalTokens} tokens) is over ${chat.maxPromptTokens}`)
  }
  let provider = options.provider
  if (!provider) {
    const key = readWorkspaceSecret(courseDir, ANTHROPIC_KEY_ENV, env)
    if (!key) {
      throw new Error(
        `${ANTHROPIC_KEY_ENV} is not set. Export it or put it in the workspace's .env (gitignored).`,
      )
    }
    provider = await createAnthropicProvider({
      apiKey: key,
      model: chat.model,
      refusalFallback: chat.refusalFallback,
    })
  }
  const splitter = new SourceSplitter()
  const state = { source: 'lesson' }
  let usage: AnswerUsage | null = null
  let stopReason: string | null = null
  const ac = new AbortController()
  for await (const e of provider.answer(
    { system, messages, maxTokens: chat.maxOutputTokens, effort: chat.effort },
    ac.signal,
  )) {
    if (e.type === 'text') {
      write(renderParts(splitter.feed(e.text), state))
    } else {
      write(renderParts(splitter.flush(), state) + '\n')
      usage = e.usage
      stopReason = e.stopReason
    }
  }
  if (stopReason === 'refusal') log('Claude declined to answer this question.')
  if (stopReason === 'max_tokens') log('The answer was cut off (chat.maxOutputTokens).')
  if (usage) {
    log(
      `${chat.model}: in ${usage.input} (cache read ${usage.cacheRead}, write ${usage.cacheWrite}), out ${usage.output}`,
    )
  }
  return {
    model: chat.model,
    systemTokens: budget.systemTokens,
    totalTokens: budget.totalTokens,
    usage,
    stopReason,
  }
}
