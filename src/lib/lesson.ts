import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseLimitOverrides, type PackLimits } from './context-pack/limits.js'
import { writeFileInside } from './fs-safe.js'
import { deckFrontmatter } from './slidev.js'
import { isPlainObject, readJsonFile, validateLessonId, validateRepoPattern } from './validate.js'

export type LessonJson = {
  schemaVersion: 1
  id: string
  /** Exact repo-relative paths (no glob syntax; `app/[id]/page.tsx` is taken literally). */
  files: string[]
  /** minimatch globs, matched against repo-relative paths (dotfiles included). */
  globs: string[]
  focus: string
  notes: string
  /** Optional overrides for context-pack limits (see PACK_LIMITS). */
  limits?: Partial<PackLimits>
}

/**
 * Default selection: the README plus common source roots, including the Spring + SPA layout
 * (`backend/`, `frontend/`) used by the first target course.
 */
export const DEFAULT_LESSON_GLOBS = ['README.md', 'src/**', 'lib/**', 'backend/**', 'frontend/**']

export function lessonJsonPath(lessonRoot: string): string {
  return path.join(lessonRoot, 'lesson.json')
}

function optionalString(obj: Record<string, unknown>, key: string, file: string): string {
  const v = obj[key]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Error(`${file}: "${key}" must be a string`)
  return v
}

function patternList(obj: Record<string, unknown>, key: string, file: string): string[] {
  const v = obj[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(`${file}: "${key}" must be an array of strings`)
  return v.map((p, i) => validateRepoPattern(p, `${file}: ${key}[${i}]`))
}

/** Parse and validate lesson.json. `expectedId` is the lesson directory name. */
export function parseLessonJson(raw: unknown, file: string, expectedId: string): LessonJson {
  if (!isPlainObject(raw)) throw new Error(`${file}: expected a JSON object`)
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new Error(`${file}: unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}`)
  }
  const id = raw.id === undefined ? expectedId : raw.id
  if (id !== expectedId) {
    throw new Error(
      `${file}: id ${JSON.stringify(id)} does not match the lesson directory "${expectedId}"`,
    )
  }
  validateLessonId(expectedId)
  const lesson: LessonJson = {
    schemaVersion: 1,
    id: expectedId,
    files: patternList(raw, 'files', file),
    globs: patternList(raw, 'globs', file),
    focus: optionalString(raw, 'focus', file),
    notes: optionalString(raw, 'notes', file),
  }
  const limits = parseLimitOverrides(raw.limits, file)
  if (Object.keys(limits).length > 0) lesson.limits = limits
  return lesson
}

export function readLessonJson(lessonRoot: string): LessonJson {
  const p = lessonJsonPath(lessonRoot)
  if (!existsSync(p)) {
    throw new Error(`Missing lesson config: ${p}`)
  }
  return parseLessonJson(readJsonFile(p, readFileSync(p, 'utf8')), p, path.basename(lessonRoot))
}

/** The workspace that holds `lessons/<id>/`; writes below it never follow symlinks. */
export function workspaceOfLesson(lessonRoot: string): string {
  return path.dirname(path.dirname(path.resolve(lessonRoot)))
}

export function writeLessonJson(lessonRoot: string, data: LessonJson): void {
  writeFileInside(
    workspaceOfLesson(lessonRoot),
    lessonJsonPath(lessonRoot),
    JSON.stringify(data, null, 2) + '\n',
  )
}

export function defaultLessonJson(id: string): LessonJson {
  return {
    schemaVersion: 1,
    id,
    files: [],
    globs: [...DEFAULT_LESSON_GLOBS],
    focus: '',
    notes: '',
  }
}

export function writePlaceholderSlides(lessonRoot: string, id: string, languages: string[]): void {
  const base = workspaceOfLesson(lessonRoot)
  for (const lang of languages) {
    const title = lang === 'pl' ? `Lekcja: ${id}` : `Lesson: ${id}`
    writeFileInside(
      base,
      path.join(lessonRoot, lang, 'slides.md'),
      `${deckFrontmatter({ title, lang })}

# ${title}

<!-- Draft slides; run \`course context ${id}\` for the agent context pack. -->

\`\`\`mermaid
flowchart LR
  pack[context pack] --> script[lesson script]
\`\`\`
`,
    )
  }
}
