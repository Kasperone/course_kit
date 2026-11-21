<!--
  course_kit narration player. Plays the clip for the current slide + click from the lesson's
  narration manifest (written by `course narrate`). Same-origin requests only: in a build the clips
  sit next to the deck (../narration/<lang>/), in `course dev` they come from the dev server.
  Nothing plays until the viewer turns narration on.
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

type Clip = { slide: number; click: number; file: string; duration: number; text: string }
type Loaded = { state: 'ready'; clips: Map<string, Clip> } | { state: 'missing' | 'loading' }
type Config = { lesson: string; lang: string; langs: string[]; base: string } | null

declare const __COURSE_NARRATION__: Config

const cfg: Config = typeof __COURSE_NARRATION__ === 'undefined' ? null : __COURSE_NARRATION__
const FILE_RE = /^s\d{2,3}-c\d{2,3}-[0-9a-f]{12}\.(mp3|wav)$/
const nav = useNav()

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(`course-narration:${key}`)
  } catch {
    return null
  }
}
function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(`course-narration:${key}`, value)
  } catch {
    // storage unavailable (private mode): settings just don't persist
  }
}

const langs = cfg?.langs ?? []
const initialLang = stored('lang')
const lang = ref(initialLang && langs.includes(initialLang) ? initialLang : (cfg?.lang ?? ''))
const autoNext = ref(stored('autoNext') === '1')
const on = ref(false)
const playing = ref(false)
const manifests = reactive<Record<string, Loaded>>({})
const audio = typeof Audio === 'undefined' ? null : new Audio()
if (audio) audio.preload = 'auto'

const visible = computed(
  () => cfg !== null && nav.isPlaying.value && !nav.isPrintMode.value && !nav.isEmbedded.value,
)

function dirUrl(l: string): string {
  const deckBase = new URL(import.meta.env.BASE_URL, window.location.href)
  return new URL(`${cfg!.base}${encodeURIComponent(l)}/`, deckBase).href
}

async function load(l: string): Promise<void> {
  if (manifests[l]) return
  manifests[l] = { state: 'loading' }
  try {
    const res = await fetch(new URL('manifest.json', dirUrl(l)).href, { cache: 'no-cache' })
    if (!res.ok) throw new Error(String(res.status))
    const data = (await res.json()) as { clips?: unknown }
    const clips = new Map<string, Clip>()
    for (const c of Array.isArray(data.clips) ? (data.clips as Clip[]) : []) {
      if (!Number.isInteger(c?.slide) || !Number.isInteger(c?.click)) continue
      if (typeof c.file !== 'string' || !FILE_RE.test(c.file)) continue
      clips.set(`${c.slide}.${c.click}`, c)
    }
    manifests[l] = { state: 'ready', clips }
  } catch {
    manifests[l] = { state: 'missing' }
  }
}

const step = computed(() => `${nav.currentSlideNo.value}.${nav.clicks.value}`)
const loaded = computed<Loaded>(() => manifests[lang.value] ?? { state: 'loading' })
const clip = computed(() => {
  const m = loaded.value
  return m.state === 'ready' ? m.clips.get(step.value) : undefined
})

const status = computed(() => {
  const m = loaded.value
  if (m.state === 'loading') return '…'
  if (m.state === 'missing') return 'no narration'
  if (!clip.value) return `no clip for ${step.value}`
  return `${step.value} · ${Math.round(clip.value.duration)}s`
})

function stop(): void {
  if (!audio) return
  audio.pause()
  playing.value = false
}

function playCurrent(): void {
  if (!audio || !cfg) return
  const c = clip.value
  if (!on.value || !c) return stop()
  const src = new URL(c.file, dirUrl(lang.value)).href
  if (audio.src !== src) audio.src = src
  audio.currentTime = 0
  audio.play().then(
    () => (playing.value = true),
    () => {
      // Autoplay refused or the clip failed: stay quiet, keep the deck usable.
      playing.value = false
      on.value = false
    },
  )
}

if (audio) {
  audio.addEventListener('ended', () => {
    playing.value = false
    if (on.value && autoNext.value && nav.hasNext.value) void nav.next()
  })
  audio.addEventListener('error', () => {
    playing.value = false
  })
}

function toggle(): void {
  on.value = !on.value
  if (on.value) playCurrent()
  else stop()
}

function setLang(l: string): void {
  if (l === lang.value) return
  lang.value = l
  store('lang', l)
}

watch(autoNext, (v) => store('autoNext', v ? '1' : '0'))
watch(
  () => (visible.value ? lang.value : ''),
  (l) => {
    if (l) void load(l)
  },
  { immediate: true },
)
watch([step, lang, loaded], () => {
  if (on.value) playCurrent()
})
onBeforeUnmount(stop)
</script>

<template>
  <div
    v-if="visible"
    class="course-narration"
    :class="{ quiet: loaded.state !== 'ready' || !clip }"
    role="group"
    aria-label="Narration"
    @keydown.stop
  >
    <button
      type="button"
      class="cn-btn"
      :aria-pressed="on"
      :title="on ? 'Turn narration off' : 'Turn narration on (plays the clip for this step)'"
      :disabled="loaded.state !== 'ready'"
      @click="toggle"
    >
      <span aria-hidden="true">{{ on ? (playing ? '❚❚' : '■') : '▶' }}</span>
      <span class="sr">{{ on ? 'Narration off' : 'Narration on' }}</span>
    </button>
    <label class="cn-auto" title="Go to the next step when a clip ends">
      <input v-model="autoNext" type="checkbox" />
      auto
    </label>
    <span class="cn-langs">
      <button
        v-for="l in langs"
        :key="l"
        type="button"
        class="cn-lang"
        :aria-pressed="l === lang"
        :title="`Narration language: ${l}`"
        @click="setLang(l)"
      >
        {{ l }}
      </button>
    </span>
    <span class="cn-status" aria-live="polite">{{ status }}</span>
  </div>
</template>

<style scoped>
.course-narration {
  position: absolute;
  top: 0.6rem;
  right: 0.75rem;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  font:
    11px/1.4 system-ui,
    sans-serif;
  color: currentColor;
  background: rgba(127, 127, 127, 0.12);
  opacity: 0.85;
}
.course-narration.quiet {
  opacity: 0.4;
}
.course-narration:hover,
.course-narration:focus-within {
  opacity: 1;
}
.cn-btn,
.cn-lang {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0 0.25rem;
  font: inherit;
}
.cn-btn:disabled {
  cursor: default;
}
.cn-lang[aria-pressed='true'] {
  font-weight: 700;
  text-decoration: underline;
}
.cn-auto {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  cursor: pointer;
}
.cn-status {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
