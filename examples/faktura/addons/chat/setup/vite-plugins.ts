// Q&A chat wiring for lesson decks (lessons/<id>/<lang>/slides.md).
//
// - Tells the panel (global-top.vue) which lesson/language it belongs to and where the API is, via
//   the compile-time constant __COURSE_CHAT__. The API is always the same-origin path
//   /@course-chat/v1/: `course serve` serves the built decks and the API from one origin.
// - `course dev` runs the backend on an ephemeral 127.0.0.1 port and passes it as
//   COURSE_CHAT_PORT; the dev server proxies /@course-chat/ there (Host and Origin unchanged, so
//   the backend's origin checks still apply). Without it the panel says the backend is not running.
//
// No API keys here: they stay in the course_kit process, and the deck never calls a provider.
import { existsSync } from 'node:fs'
import path from 'node:path'

const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/
const LESSON_RE = /^[a-z0-9][a-z0-9.-]{0,99}$/i
const API = '/@course-chat/v1/'

type Options = { userRoot: string; mode: string }

/** lessons/<id>/<lang>/ inside a course workspace, or null for any other deck. */
function lessonOf(userRoot: string): { lesson: string; lang: string } | null {
  const lang = path.basename(userRoot)
  const lesson = path.basename(path.dirname(userRoot))
  const lessons = path.dirname(path.dirname(userRoot))
  if (path.basename(lessons) !== 'lessons') return null
  if (!LANG_RE.test(lang) || !LESSON_RE.test(lesson)) return null
  if (!existsSync(path.join(path.dirname(lessons), 'course.json'))) return null
  return { lesson, lang }
}

function chatPlugin(options: Options) {
  const where = lessonOf(path.resolve(options.userRoot))
  const chat = where && { lesson: where.lesson, lang: where.lang, api: API }
  const port = Number(process.env.COURSE_CHAT_PORT)
  const proxy =
    options.mode === 'dev' && chat !== null && Number.isInteger(port) && port > 0 && port < 65536
  return {
    name: 'course-chat',
    config() {
      return {
        define: { __COURSE_CHAT__: JSON.stringify(chat) },
        ...(proxy
          ? {
              server: {
                proxy: {
                  '/@course-chat/': { target: `http://127.0.0.1:${port}`, changeOrigin: false },
                },
              },
            }
          : {}),
      }
    },
  }
}

export default function setupVitePlugins(options: Options) {
  return [chatPlugin(options)]
}
