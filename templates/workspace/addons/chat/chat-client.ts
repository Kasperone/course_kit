// course_kit chat client logic, kept free of Vue so it can be unit-tested. Same-origin requests
// only (the API path is relative to the page's own origin); answers are turned into a small set of
// text blocks and never into HTML, links or images, so an answer cannot make the browser load
// anything.

export type SseEvent = { event: string; data: unknown }

/** Incremental parser for `text/event-stream` (event + data lines; comments ignored). */
export class SseParser {
  private buffer = ''
  /** A trailing CR waits for the next chunk (it may be half of a CRLF). */
  private cr = ''

  push(text: string): SseEvent[] {
    let chunk = this.cr + text
    this.cr = chunk.endsWith('\r') ? '\r' : ''
    if (this.cr) chunk = chunk.slice(0, -1)
    this.buffer += chunk.replace(/\r\n?/g, '\n')
    const events: SseEvent[] = []
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length === 0) continue
      try {
        events.push({ event, data: JSON.parse(data.join('\n')) as unknown })
      } catch {
        // ignore a malformed event
      }
    }
    return events
  }
}

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'slide'; v: string; n: number }

export type Block =
  { t: 'p'; inl: Inline[] } | { t: 'ul' | 'ol'; items: Inline[][] } | { t: 'code'; v: string }

const SLIDE_RE = /\b(?:slides?|slajd(?:zie|u|y|ów|ach)?)\s+(\d{1,3})\b/gi

function textWithSlides(text: string, out: Inline[]): void {
  let last = 0
  for (const m of text.matchAll(SLIDE_RE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    out.push({ t: 'slide', v: m[0], n: Number(m[1]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
}

/** Inline code, bold and "slide N" references; links and images become plain text. */
export function parseInline(text: string): Inline[] {
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[$1]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
  const out: Inline[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (const m of plain.matchAll(re)) {
    if (m.index > last) textWithSlides(plain.slice(last, m.index), out)
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] })
    else out.push({ t: 'strong', v: m[2]! })
    last = m.index + m[0].length
  }
  if (last < plain.length) textWithSlides(plain.slice(last), out)
  return out
}

/** Paragraphs, bulleted/numbered lists and fenced code; everything else is a paragraph. */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let list: { t: 'ul' | 'ol'; items: Inline[][] } | null = null
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inl: parseInline(para.join(' ')) })
    para = []
    if (list) blocks.push(list)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) {
        code.push(lines[i]!)
      }
      blocks.push({ t: 'code', v: code.join('\n') })
      continue
    }
    const item = line.match(/^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/)
    if (item) {
      const t = item[1] ? 'ul' : 'ol'
      if (para.length) {
        blocks.push({ t: 'p', inl: parseInline(para.join(' ')) })
        para = []
      }
      if (!list || list.t !== t) {
        if (list) blocks.push(list)
        list = { t, items: [] }
      }
      list.items.push(parseInline(item[3]!))
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    if (list) {
      blocks.push(list)
      list = null
    }
    para.push(line.replace(/^\s*#{1,6}\s+/, '').trim())
  }
  flush()
  return blocks
}

export type Source = 'lesson' | 'general'
export type AnswerChunk = { source: Source; text: string }

/** Append streamed text, merging with the previous chunk of the same source. */
export function appendChunk(chunks: AnswerChunk[], source: Source, text: string): void {
  const last = chunks[chunks.length - 1]
  if (last && last.source === source) last.text += text
  else chunks.push({ source, text })
}

export type Status = {
  apiVersion?: number
  answers?: 'ready' | 'no-key' | 'unavailable' | 'disabled'
  pack?: 'ok' | 'missing' | 'stale' | 'too-large' | null
  /** anthropic-api, claude-cli or cursor-cli. */
  provider?: string | null
  /** Why a CLI provider cannot answer (not installed / not logged in); never a secret. */
  providerMessage?: string | null
  billing?: 'api' | 'subscription' | null
  /** Who receives the question and the materials (Anthropic or Cursor). */
  vendor?: string | null
  model?: string | null
  limits?: { maxQuestionChars: number; historyTurns: number } | null
}

export const API_VERSION = 1

export type PanelState =
  | 'checking'
  | 'ready'
  | 'stale'
  | 'no-key'
  | 'unavailable'
  | 'no-pack'
  | 'too-large'
  | 'disabled'
  | 'offline'
  | 'outdated'

export function panelState(status: Status | null): PanelState {
  if (!status) return 'offline'
  if (status.apiVersion !== API_VERSION) return 'outdated'
  if (status.answers === 'disabled') return 'disabled'
  if (status.pack === 'missing') return 'no-pack'
  if (status.pack === 'too-large') return 'too-large'
  if (status.answers === 'no-key') return 'no-key'
  if (status.answers === 'unavailable') return 'unavailable'
  return status.pack === 'stale' ? 'stale' : 'ready'
}

export async function fetchStatus(
  api: string,
  lesson: string,
  lang: string,
): Promise<Status | null> {
  try {
    const q = `lesson=${encodeURIComponent(lesson)}&lang=${encodeURIComponent(lang)}`
    const res = await fetch(`${api}status?${q}`, { cache: 'no-store' })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
      return null
    }
    return (await res.json()) as Status
  } catch {
    return null
  }
}

export type AskBody = {
  lesson: string
  lang: string
  slide: number
  click: number
  question: string
  history: { role: 'user' | 'assistant'; text: string }[]
}

/**
 * POST a question and feed each SSE event to `onEvent`. A refusal before the stream starts (rate
 * limit, no key, ...) arrives as one `error` event with the server's code.
 */
export async function askStream(
  api: string,
  body: AskBody,
  signal: AbortSignal,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const res = await fetch(`${api}ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  })
  if (!res.ok || !res.body) {
    let data: { error?: string; message?: string } = {}
    try {
      data = (await res.json()) as typeof data
    } catch {
      // not JSON
    }
    onEvent({
      event: 'error',
      data: { code: data.error ?? 'upstream', message: data.message ?? '' },
    })
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e)
  }
  for (const e of parser.push(decoder.decode() + '\n\n')) onEvent(e)
}

const EN = {
  ask: 'Ask',
  title: 'Questions about this lesson',
  placeholder: 'Ask about this lesson… (Enter sends, Shift+Enter adds a line)',
  send: 'Send',
  stop: 'Stop',
  close: 'Close',
  you: 'You',
  tutor: 'Tutor',
  thinking: 'Thinking…',
  notFromLesson: 'Not from this lesson',
  offTopic: 'Outside the lesson topic',
  cut: 'The answer was cut off.',
  goToSlide: 'Go to',
  privacy:
    'Your question and the lesson materials (including quoted code) are sent to Anthropic by your local course backend.',
  privacyCursor:
    'Your question and the lesson materials (including quoted code) are sent to Cursor (and its model provider) by your local course backend.',
  state: {
    checking: 'Checking the local backend…',
    ready: '',
    stale: 'The context pack is older than the pinned commit; answers may be outdated.',
    'no-key':
      'No API key: add ANTHROPIC_API_KEY to the course workspace .env (or use a CLI provider, see the README).',
    unavailable: 'The chat CLI cannot answer yet:',
    'no-pack': 'No context pack for this lesson: run `course context <lesson-id>`.',
    'too-large': 'The lesson materials are too large for the chat.',
    disabled: 'The Q&A chat is turned off for this course.',
    offline: 'Q&A needs the local backend: run `course serve` (or `course dev`).',
    outdated: 'This chat addon does not match the course_kit version; update addons/chat.',
  } as Record<PanelState, string>,
  errors: {
    'rate-limited': 'Too many questions; try again in a moment.',
    busy: 'Another answer is still running.',
    auth: 'The API key was rejected.',
    offline: 'Cannot reach the Claude API (offline?).',
    refused: 'Claude declined to answer this question.',
    'no-key': 'No API key: add ANTHROPIC_API_KEY to the course workspace .env.',
    unavailable: 'The chat CLI cannot answer:',
    'not-logged-in': 'The chat CLI is not logged in:',
    timeout: 'The answer took too long and was stopped.',
    'cut-off': 'The answer was too long and was stopped.',
    'no-pack': 'No context pack for this lesson: run `course context <lesson-id>`.',
    other: 'The answer failed:',
  } as Record<string, string>,
}

const PL: typeof EN = {
  ask: 'Zapytaj',
  title: 'Pytania o tę lekcję',
  placeholder: 'Zapytaj o tę lekcję… (Enter wysyła, Shift+Enter – nowa linia)',
  send: 'Wyślij',
  stop: 'Zatrzymaj',
  close: 'Zamknij',
  you: 'Ty',
  tutor: 'Tutor',
  thinking: 'Myślę…',
  notFromLesson: 'Spoza tej lekcji',
  offTopic: 'Poza tematem lekcji',
  cut: 'Odpowiedź została ucięta.',
  goToSlide: 'Przejdź do',
  privacy:
    'Twoje pytanie i materiały lekcji (w tym cytowany kod) wysyła do Anthropic Twój lokalny backend kursu.',
  privacyCursor:
    'Twoje pytanie i materiały lekcji (w tym cytowany kod) wysyła do Cursora (i jego dostawcy modelu) Twój lokalny backend kursu.',
  state: {
    checking: 'Sprawdzam lokalny backend…',
    ready: '',
    stale: 'Context pack jest starszy niż przypięty commit; odpowiedzi mogą być nieaktualne.',
    'no-key':
      'Brak klucza API: dodaj ANTHROPIC_API_KEY do pliku .env w workspace kursu (albo użyj dostawcy CLI, patrz README).',
    unavailable: 'CLI czatu nie może jeszcze odpowiadać:',
    'no-pack': 'Brak context packa dla tej lekcji: uruchom `course context <lesson-id>`.',
    'too-large': 'Materiały lekcji są za duże dla czatu.',
    disabled: 'Czat Q&A jest wyłączony dla tego kursu.',
    offline: 'Czat wymaga lokalnego backendu: uruchom `course serve` (lub `course dev`).',
    outdated: 'Ten dodatek czatu nie pasuje do wersji course_kit; zaktualizuj addons/chat.',
  },
  errors: {
    'rate-limited': 'Za dużo pytań; spróbuj za chwilę.',
    busy: 'Poprzednia odpowiedź jeszcze trwa.',
    auth: 'Klucz API został odrzucony.',
    offline: 'Brak połączenia z API Claude (offline?).',
    refused: 'Claude odmówił odpowiedzi na to pytanie.',
    'no-key': 'Brak klucza API: dodaj ANTHROPIC_API_KEY do pliku .env w workspace kursu.',
    unavailable: 'CLI czatu nie może odpowiedzieć:',
    'not-logged-in': 'CLI czatu nie jest zalogowane:',
    timeout: 'Odpowiedź trwała za długo i została przerwana.',
    'cut-off': 'Odpowiedź była za długa i została przerwana.',
    'no-pack': 'Brak context packa dla tej lekcji: uruchom `course context <lesson-id>`.',
    other: 'Odpowiedź nie powiodła się:',
  },
}

export type Strings = typeof EN

/** UI strings in the deck language (English for languages without a translation). */
export function strings(lang: string): Strings {
  return lang.split('-')[0] === 'pl' ? PL : EN
}

/** Codes whose text ends with ":" and is followed by the server's message (a command to run). */
const WITH_MESSAGE = new Set(['unavailable', 'not-logged-in'])

export function errorText(s: Strings, code: string, message: string): string {
  const text = s.errors[code]
  if (text && WITH_MESSAGE.has(code)) return message ? `${text} ${message}` : text
  return text ?? `${s.errors.other} ${message || code}`
}

/** The state line, with the server's reason when a CLI provider is not ready. */
export function stateText(s: Strings, state: PanelState, status: Status | null): string {
  const text = s.state[state]
  return state === 'unavailable' && status?.providerMessage
    ? `${text} ${status.providerMessage}`
    : text
}

/** Who the question goes to, for the privacy line under the input. */
export function privacyText(s: Strings, status: Status | null): string {
  return status?.vendor === 'Cursor' ? s.privacyCursor : s.privacy
}
