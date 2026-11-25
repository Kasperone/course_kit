<!--
  course_kit Q&A chat. A small "Ask" button on the slideshow opens a side panel (teleported to the
  page body, so it is not scaled with the slide). Questions go to the local course backend at the
  same-origin path /@course-chat/v1/ with the current slide and click; answers stream back and are
  rendered as plain text blocks (no HTML, links or images). Nothing is stored; the conversation
  lives in memory until the page is reloaded.
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  appendChunk,
  askStream,
  errorText,
  fetchStatus,
  panelState,
  parseMarkdown,
  privacyText,
  stateText,
  strings,
  type AnswerChunk,
  type PanelState,
  type Source,
  type Status,
} from './chat-client'

type Config = { lesson: string; lang: string; api: string } | null
type Turn =
  | { role: 'user'; text: string }
  | {
      role: 'assistant'
      chunks: AnswerChunk[]
      pending: boolean
      offTopic: boolean
      cut: boolean
      error: string | null
    }

declare const __COURSE_CHAT__: Config

const cfg: Config = typeof __COURSE_CHAT__ === 'undefined' ? null : __COURSE_CHAT__
const nav = useNav()
const s = strings(cfg?.lang ?? 'en')

const open = ref(false)
const status = ref<Status | null>(null)
const state = ref<PanelState>('checking')
const question = ref('')
const turns = reactive<Turn[]>([])
const busy = ref(false)
const input = ref<HTMLTextAreaElement | null>(null)
const pill = ref<HTMLButtonElement | null>(null)
const log = ref<HTMLElement | null>(null)
let controller: AbortController | null = null

const visible = computed(
  () => cfg !== null && nav.isPlaying.value && !nav.isPrintMode.value && !nav.isEmbedded.value,
)
const canAsk = computed(() => (state.value === 'ready' || state.value === 'stale') && !busy.value)
const maxChars = computed(() => status.value?.limits?.maxQuestionChars ?? 2000)
const historyTurns = computed(() => status.value?.limits?.historyTurns ?? 6)

async function refresh(): Promise<void> {
  if (!cfg) return
  state.value = 'checking'
  status.value = await fetchStatus(cfg.api, cfg.lesson, cfg.lang)
  state.value = panelState(status.value)
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) {
    void refresh()
    await nextTick()
    input.value?.focus()
  } else {
    pill.value?.focus()
  }
}

function close(): void {
  if (!open.value) return
  open.value = false
  pill.value?.focus()
}

function scrollDown(): void {
  void nextTick(() => {
    if (log.value) log.value.scrollTop = log.value.scrollHeight
  })
}

/** Completed exchanges, as plain text, for the next question's context. */
function history(): { role: 'user' | 'assistant'; text: string }[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = []
  for (let i = 0; i + 1 < turns.length; i += 2) {
    const q = turns[i]!
    const a = turns[i + 1]!
    if (q.role !== 'user' || a.role !== 'assistant' || a.pending || a.error) continue
    const text = a.chunks.map((c) => c.text).join('')
    if (!text.trim()) continue
    out.push({ role: 'user', text: q.text }, { role: 'assistant', text: text.slice(0, 4000) })
  }
  return out.slice(-historyTurns.value * 2)
}

async function send(): Promise<void> {
  const q = question.value.trim()
  if (!cfg || !q || !canAsk.value) return
  const previous = history()
  turns.push({ role: 'user', text: q })
  const answer = reactive({
    role: 'assistant' as const,
    chunks: [] as AnswerChunk[],
    pending: true,
    offTopic: false,
    cut: false,
    error: null as string | null,
  })
  turns.push(answer)
  question.value = ''
  busy.value = true
  controller = new AbortController()
  scrollDown()
  try {
    await askStream(
      cfg.api,
      {
        lesson: cfg.lesson,
        lang: cfg.lang,
        slide: nav.currentSlideNo.value,
        click: nav.clicks.value,
        question: q.slice(0, maxChars.value),
        history: previous,
      },
      controller.signal,
      ({ event, data }) => {
        const d = (data ?? {}) as Record<string, unknown>
        if (event === 'delta' && typeof d.text === 'string') {
          appendChunk(
            answer.chunks,
            (d.source === 'general' ? 'general' : 'lesson') as Source,
            d.text,
          )
          scrollDown()
        } else if (event === 'scope' && d.value === 'off-topic') {
          answer.offTopic = true
        } else if (event === 'done') {
          answer.cut = d.stopReason === 'max_tokens'
        } else if (event === 'error') {
          const code = String(d.code ?? 'upstream')
          if (code === 'refused') answer.chunks.splice(0)
          answer.error = errorText(s, code, String(d.message ?? ''))
          if (['no-key', 'no-pack', 'unavailable', 'not-logged-in'].includes(code)) void refresh()
        }
      },
    )
  } catch (err) {
    if (!controller?.signal.aborted) {
      answer.error = s.state.offline
      void refresh()
    }
  } finally {
    answer.pending = false
    busy.value = false
    controller = null
    scrollDown()
  }
}

function stop(): void {
  controller?.abort()
}

/** Panel keys (Slidev shortcuts never see them): Escape closes. */
function onPanelKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

/** In the question box, Enter sends and Shift+Enter starts a new line. */
function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

function goTo(n: number): void {
  void nav.go(n)
}

watch(visible, (v) => {
  if (!v) close()
})
</script>

<template>
  <button
    v-if="visible"
    ref="pill"
    type="button"
    class="course-chat-pill"
    :aria-expanded="open"
    aria-controls="course-chat-panel"
    :title="s.title"
    @click="toggle"
    @keydown.stop
  >
    {{ s.ask }}
  </button>
  <Teleport to="body">
    <aside
      v-if="visible && open"
      id="course-chat-panel"
      class="course-chat"
      role="dialog"
      :aria-label="s.title"
      @keydown.stop="onPanelKey"
    >
      <header class="cc-head">
        <strong>{{ s.title }}</strong>
        <button type="button" class="cc-x" :title="s.close" :aria-label="s.close" @click="close">
          ×
        </button>
      </header>
      <p v-if="s.state[state]" class="cc-state" :class="state">
        {{ stateText(s, state, status) }}
      </p>
      <div ref="log" class="cc-log" aria-live="polite">
        <template v-for="(t, i) in turns" :key="i">
          <div v-if="t.role === 'user'" class="cc-q">
            <span class="cc-who">{{ s.you }}</span>
            <p>{{ t.text }}</p>
          </div>
          <div v-else class="cc-a">
            <span class="cc-who">{{ s.tutor }}</span>
            <span v-if="t.offTopic" class="cc-badge off">{{ s.offTopic }}</span>
            <p v-if="t.pending && t.chunks.length === 0" class="cc-thinking">{{ s.thinking }}</p>
            <section
              v-for="(c, j) in t.chunks"
              :key="j"
              class="cc-chunk"
              :class="{ general: c.source === 'general' }"
            >
              <span v-if="c.source === 'general'" class="cc-badge">{{ s.notFromLesson }}</span>
              <template v-for="(b, k) in parseMarkdown(c.text)" :key="k">
                <pre v-if="b.t === 'code'" class="cc-code"><code>{{ b.v }}</code></pre>
                <component :is="b.t" v-else-if="b.t === 'ul' || b.t === 'ol'">
                  <li v-for="(item, m) in b.items" :key="m">
                    <template v-for="(x, n) in item" :key="n">
                      <code v-if="x.t === 'code'">{{ x.v }}</code>
                      <strong v-else-if="x.t === 'strong'">{{ x.v }}</strong>
                      <button
                        v-else-if="x.t === 'slide'"
                        type="button"
                        class="cc-slide"
                        :title="`${s.goToSlide} ${x.v}`"
                        @click="goTo(x.n)"
                      >
                        {{ x.v }}
                      </button>
                      <template v-else>{{ x.v }}</template>
                    </template>
                  </li>
                </component>
                <p v-else>
                  <template v-for="(x, n) in b.inl" :key="n">
                    <code v-if="x.t === 'code'">{{ x.v }}</code>
                    <strong v-else-if="x.t === 'strong'">{{ x.v }}</strong>
                    <button
                      v-else-if="x.t === 'slide'"
                      type="button"
                      class="cc-slide"
                      :title="`${s.goToSlide} ${x.v}`"
                      @click="goTo(x.n)"
                    >
                      {{ x.v }}
                    </button>
                    <template v-else>{{ x.v }}</template>
                  </template>
                </p>
              </template>
            </section>
            <p v-if="t.cut" class="cc-note">{{ s.cut }}</p>
            <p v-if="t.error" class="cc-error">{{ t.error }}</p>
          </div>
        </template>
      </div>
      <form class="cc-form" @submit.prevent="send">
        <textarea
          ref="input"
          v-model="question"
          rows="3"
          :maxlength="maxChars"
          :placeholder="s.placeholder"
          :disabled="state !== 'ready' && state !== 'stale'"
          @keydown="onInputKey"
        />
        <div class="cc-actions">
          <small class="cc-privacy">{{ privacyText(s, status) }}</small>
          <button v-if="busy" type="button" @click="stop">{{ s.stop }}</button>
          <button v-else type="submit" :disabled="!canAsk || !question.trim()">{{ s.send }}</button>
        </div>
      </form>
    </aside>
  </Teleport>
</template>

<style scoped>
.course-chat-pill {
  position: absolute;
  top: 2.3rem;
  right: 0.75rem;
  z-index: 20;
  padding: 0.15rem 0.6rem;
  border: 0;
  border-radius: 999px;
  font:
    11px/1.4 system-ui,
    sans-serif;
  color: currentColor;
  background: rgba(127, 127, 127, 0.12);
  opacity: 0.85;
  cursor: pointer;
}
.course-chat-pill:hover,
.course-chat-pill:focus-visible,
.course-chat-pill[aria-expanded='true'] {
  opacity: 1;
}
.course-chat {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  width: min(420px, 100vw);
  font:
    14px/1.5 system-ui,
    sans-serif;
  color: #1f2328;
  background: #ffffff;
  border-left: 1px solid rgba(127, 127, 127, 0.35);
  box-shadow: -6px 0 24px rgba(0, 0, 0, 0.18);
}
@media (prefers-color-scheme: dark) {
  .course-chat {
    color: #e6edf3;
    background: #161b22;
  }
}
.cc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid rgba(127, 127, 127, 0.25);
}
.cc-x {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 1.3rem;
  line-height: 1;
  cursor: pointer;
}
.cc-state {
  margin: 0;
  padding: 0.5rem 0.8rem;
  font-size: 12px;
  background: rgba(210, 153, 34, 0.15);
}
.cc-state.checking {
  background: transparent;
  opacity: 0.7;
}
.cc-log {
  flex: 1;
  overflow-y: auto;
  padding: 0.6rem 0.8rem;
}
.cc-q,
.cc-a {
  margin-bottom: 0.9rem;
}
.cc-q p {
  margin: 0.1rem 0 0;
  white-space: pre-wrap;
}
.cc-who {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.65;
  margin-right: 0.4rem;
}
.cc-chunk p,
.cc-chunk ul,
.cc-chunk ol {
  margin: 0.3rem 0;
}
.cc-chunk ul,
.cc-chunk ol {
  padding-left: 1.2rem;
}
.cc-chunk ul {
  list-style: disc;
}
.cc-chunk ol {
  list-style: decimal;
}
.cc-chunk.general {
  margin: 0.4rem 0;
  padding: 0.3rem 0.6rem;
  border-left: 3px solid #d29922;
  background: rgba(210, 153, 34, 0.08);
}
.cc-badge {
  display: inline-block;
  font-size: 11px;
  padding: 0 0.4rem;
  border-radius: 4px;
  background: rgba(210, 153, 34, 0.25);
}
.cc-badge.off {
  background: rgba(127, 127, 127, 0.2);
}
.cc-code {
  margin: 0.4rem 0;
  padding: 0.5rem;
  overflow-x: auto;
  font-size: 12px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.12);
}
.cc-chunk code {
  font-family: ui-monospace, monospace;
  font-size: 0.92em;
}
.cc-slide {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline dotted;
  cursor: pointer;
}
.cc-thinking,
.cc-note {
  margin: 0.2rem 0;
  font-size: 12px;
  opacity: 0.7;
}
.cc-error {
  margin: 0.2rem 0;
  font-size: 12px;
  color: #cf222e;
}
.cc-form {
  padding: 0.6rem 0.8rem;
  border-top: 1px solid rgba(127, 127, 127, 0.25);
}
.cc-form textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  padding: 0.4rem;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(127, 127, 127, 0.4);
  border-radius: 6px;
}
.cc-actions {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
  margin-top: 0.4rem;
}
.cc-privacy {
  flex: 1;
  font-size: 10.5px;
  line-height: 1.3;
  opacity: 0.6;
}
.cc-actions button {
  padding: 0.3rem 0.9rem;
  border: 1px solid rgba(127, 127, 127, 0.4);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.cc-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
@media (prefers-reduced-motion: no-preference) {
  .course-chat {
    animation: cc-in 0.15s ease-out;
  }
  @keyframes cc-in {
    from {
      transform: translateX(16px);
      opacity: 0;
    }
  }
}
</style>
