import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  addSubmodule,
  checkoutSubmoduleCommit,
  initGitRepo,
  readHeadCommit,
  resolveTargetRepo,
} from '../lib/git.js'
import { defaultLessonJson, writeLessonJson, writePlaceholderSlides } from '../lib/lesson.js'
import { defaultOutDir, templatesDir } from '../lib/paths.js'

export const SUBMODULE_PATH = 'target-repo'

export type CourseJson = {
  schemaVersion: 1
  targetRepo: string
  pinnedCommit: string
  languages: string[]
  referenceMode: 'pinned-path' | 'submodule'
  submodulePath: string | null
}

export type InitOptions = {
  targetRepo: string
  outDir?: string
  languages: string[]
  submodule: boolean
  cwd?: string
}

function parseLanguages(langArg: string | undefined): string[] {
  const raw = langArg ?? 'pl,en'
  const langs = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (langs.length === 0) {
    throw new Error('At least one language is required (e.g. pl,en)')
  }
  return [...new Set(langs)]
}

export function parseInitArgs(opts: {
  target?: string
  out?: string
  lang?: string
  submodule?: boolean
  cwd?: string
}): InitOptions {
  if (!opts.target) {
    throw new Error('Missing required argument: <path-to-target-repo>')
  }
  return {
    targetRepo: opts.target,
    outDir: opts.out,
    languages: parseLanguages(opts.lang),
    submodule: Boolean(opts.submodule),
    cwd: opts.cwd ?? process.cwd(),
  }
}

function writeCourseJson(outDir: string, data: CourseJson): void {
  writeFileSync(path.join(outDir, 'course.json'), JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function writeLessonPlaceholders(outDir: string, languages: string[]): void {
  const id = '01-placeholder'
  const lessonRoot = path.join(outDir, 'lessons', id)
  mkdirSync(lessonRoot, { recursive: true })
  writeLessonJson(lessonRoot, defaultLessonJson(id))
  writePlaceholderSlides(lessonRoot, id, languages)
}

function writeAudioTree(outDir: string): void {
  const localDir = path.join(outDir, 'audio', 'local')
  mkdirSync(localDir, { recursive: true })
  writeFileSync(path.join(outDir, 'audio', 'local', '.gitkeep'), '', 'utf8')
  writeFileSync(
    path.join(outDir, 'audio', 'ATTRIBUTION.md'),
    `# Audio attribution

Generated narration clips belong in \`audio/local/\` (gitignored).
Do not commit provider-generated audio or API keys.
`,
    'utf8',
  )
}

export async function runInit(
  options: InitOptions,
): Promise<{ outDir: string; course: CourseJson }> {
  const targetRepo = resolveTargetRepo(options.targetRepo)
  const pinnedCommit = readHeadCommit(targetRepo)
  const outDir = path.resolve(options.outDir ?? defaultOutDir(targetRepo, options.cwd))

  if (existsSync(outDir) && requireNotEmpty(outDir)) {
    throw new Error(`Output directory already exists and is not empty: ${outDir}`)
  }

  mkdirSync(outDir, { recursive: true })

  const templateRoot = templatesDir()
  cpSync(templateRoot, outDir, { recursive: true })

  writeLessonPlaceholders(outDir, options.languages)
  writeAudioTree(outDir)

  const course: CourseJson = {
    schemaVersion: 1,
    targetRepo,
    pinnedCommit,
    languages: options.languages,
    referenceMode: options.submodule ? 'submodule' : 'pinned-path',
    submodulePath: options.submodule ? SUBMODULE_PATH : null,
  }
  writeCourseJson(outDir, course)

  if (options.submodule) {
    initGitRepo(outDir)
    addSubmodule(outDir, targetRepo, SUBMODULE_PATH)
    checkoutSubmoduleCommit(outDir, SUBMODULE_PATH, pinnedCommit)
  }

  return { outDir, course }
}

function requireNotEmpty(dir: string): boolean {
  return readdirSync(dir).length > 0
}
