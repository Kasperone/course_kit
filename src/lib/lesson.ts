import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type LessonJson = {
  schemaVersion: 1
  id: string
  files: string[]
  globs: string[]
  focus: string
  notes: string
}

export const DEFAULT_LESSON_GLOBS = ['README.md', 'src/**', 'lib/**']

export function lessonJsonPath(lessonRoot: string): string {
  return path.join(lessonRoot, 'lesson.json')
}

export function readLessonJson(lessonRoot: string): LessonJson {
  const p = lessonJsonPath(lessonRoot)
  if (!existsSync(p)) {
    throw new Error(`Missing lesson config: ${p}`)
  }
  return JSON.parse(readFileSync(p, 'utf8')) as LessonJson
}

export function writeLessonJson(lessonRoot: string, data: LessonJson): void {
  writeFileSync(lessonJsonPath(lessonRoot), JSON.stringify(data, null, 2) + '\n', 'utf8')
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
  for (const lang of languages) {
    const dir = path.join(lessonRoot, lang)
    mkdirSync(dir, { recursive: true })
    const title = lang === 'pl' ? `Lekcja: ${id}` : `Lesson: ${id}`
    writeFileSync(
      path.join(dir, 'slides.md'),
      `---
theme: default
title: ${title}
lang: ${lang}
---

# ${title}

<!-- Draft slides; run \`course context ${id}\` for the agent context pack. -->

\`\`\`mermaid
flowchart LR
  pack[context pack] --> script[lesson script]
\`\`\`
`,
      'utf8',
    )
  }
}
