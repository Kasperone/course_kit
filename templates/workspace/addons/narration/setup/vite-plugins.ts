// Narration player wiring for lesson decks (lessons/<id>/<lang>/slides.md).
//
// - Tells the player (global-top.vue) which lesson/language it shows and where clips live, via
//   the compile-time constant __COURSE_NARRATION__.
// - Dev server: serves audio/local/<lang>/<lesson>/ at /@course-narration/<lang>/<file>, from
//   localhost only. Only manifest.json and clip names written by `course narrate` are served.
// - Builds: clips are copied by `course build` to dist/<lesson>/narration/<lang>/, which the
//   player reaches as ../narration/ relative to the deck base (/<lesson>/<lang>/).
//
// No external requests: the player only fetches same-origin, relative URLs.
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/
const LESSON_RE = /^[a-z0-9][a-z0-9.-]{0,99}$/i
const FILE_RE = /^(manifest\.json|s\d{2,3}-c\d{2,3}-[0-9a-f]{12}\.(mp3|wav))$/
const MIME: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}
const DEV_PREFIX = '/@course-narration/'

type Options = { userRoot: string; mode: string }

type Narration = { lesson: string; lang: string; langs: string[]; base: string } | null

/** lessons/<id>/<lang>/ inside a course workspace, or null for any other deck. */
function lessonOf(userRoot: string): { ws: string; lesson: string; lang: string } | null {
  const lang = path.basename(userRoot)
  const lesson = path.basename(path.dirname(userRoot))
  const lessons = path.dirname(path.dirname(userRoot))
  const ws = path.dirname(lessons)
  if (path.basename(lessons) !== 'lessons') return null
  if (!LANG_RE.test(lang) || !LESSON_RE.test(lesson)) return null
  if (!existsSync(path.join(ws, 'course.json'))) return null
  return { ws, lesson, lang }
}

function courseLanguages(ws: string, fallback: string): string[] {
  try {
    const course = JSON.parse(readFileSync(path.join(ws, 'course.json'), 'utf8')) as {
      languages?: unknown
    }
    const langs = Array.isArray(course.languages)
      ? course.languages.filter((l): l is string => typeof l === 'string' && LANG_RE.test(l))
      : []
    return langs.length > 0 ? langs : [fallback]
  } catch {
    return [fallback]
  }
}

function narrationPlugin(options: Options) {
  const where = lessonOf(path.resolve(options.userRoot))
  const narration: Narration = where && {
    lesson: where.lesson,
    lang: where.lang,
    langs: courseLanguages(where.ws, where.lang),
    base: options.mode === 'dev' ? DEV_PREFIX : '../narration/',
  }
  return {
    name: 'course-narration',
    config() {
      return { define: { __COURSE_NARRATION__: JSON.stringify(narration) } }
    },
    configureServer(server: {
      middlewares: {
        use: (
          prefix: string,
          fn: (
            req: { url?: string; method?: string },
            res: {
              statusCode: number
              setHeader: (k: string, v: string) => void
              end: (body?: string) => void
            } & NodeJS.WritableStream,
            next: () => void,
          ) => void,
        ) => void
      }
    }) {
      if (!where || !narration) return
      server.middlewares.use(DEV_PREFIX, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const [lang, file, ...rest] = decodeURIComponent((req.url ?? '').split('?')[0]!)
          .replace(/^\/+/, '')
          .split('/')
        if (
          rest.length > 0 ||
          !lang ||
          !file ||
          !narration.langs.includes(lang) ||
          !FILE_RE.test(file)
        ) {
          res.statusCode = 404
          return res.end('Not found')
        }
        const abs = path.join(where.ws, 'audio', 'local', lang, where.lesson, file)
        let ok = false
        try {
          const st = lstatSync(abs)
          ok = st.isFile() && !st.isSymbolicLink()
        } catch {
          ok = false
        }
        if (!ok) {
          res.statusCode = 404
          return res.end('Not found')
        }
        res.statusCode = 200
        res.setHeader('Content-Type', MIME[file.split('.').pop()!] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        if (req.method === 'HEAD') return res.end()
        createReadStream(abs).pipe(res)
      })
    },
  }
}

export default function setupVitePlugins(options: Options) {
  return [narrationPlugin(options)]
}
