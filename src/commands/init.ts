import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  addSubmodule,
  checkoutSubmoduleCommit,
  initGitRepo,
  readHeadCommit,
  readShareableRemote,
  resolveTargetRepo,
} from '../lib/git.js'
import { defaultOutDir, templatesDir } from '../lib/paths.js'
import { validateLanguages } from '../lib/validate.js'

export const SUBMODULE_PATH = 'target-repo'

/**
 * Slidev renders ```plantuml blocks as `<img src="${plantUmlServer}/svg/...">` (default server:
 * plantuml.com). A data: URL turns that into a local no-op, so diagram source never leaves the
 * machine. The workspace also ships scripts/check-no-plantuml.mjs, which fails dev/build/export.
 */
export const PLANTUML_DISABLED_SERVER = 'data:text/plain,plantuml-disabled'

export type CourseJson = {
  schemaVersion: 1
  /**
   * Path to the target repository, relative to the workspace directory (POSIX separators), so the
   * file never contains a machine-specific absolute path. Override locally with COURSE_TARGET_REPO.
   */
  targetRepo: string
  /** The target's network `origin` URL without credentials, if any (informational). */
  targetRemote: string | null
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
  return validateLanguages(langs)
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
  for (const lang of languages) {
    const lessonDir = path.join(outDir, 'lessons', lang, '01-placeholder')
    mkdirSync(lessonDir, { recursive: true })
    const title = lang === 'pl' ? 'Lekcja placeholder' : 'Placeholder lesson'
    const body =
      lang === 'pl'
        ? '## Cel\n\nTreść lekcji zostanie wygenerowana przez agenta.\n'
        : '## Goal\n\nLesson content will be drafted by the coding agent.\n'
    writeFileSync(
      path.join(lessonDir, 'slides.md'),
      `---
theme: default
title: ${JSON.stringify(title)}
lang: ${lang}
plantUmlServer: ${JSON.stringify(PLANTUML_DISABLED_SERVER)}
---

# ${title}

${body}

\`\`\`mermaid
flowchart LR
  repo[Repo] --> course[course_kit]
  course --> lesson[Lesson]
\`\`\`
`,
      'utf8',
    )
  }
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

/** Env var that overrides course.json `targetRepo` on this machine (absolute or cwd-relative). */
export const TARGET_REPO_ENV = 'COURSE_TARGET_REPO'

/** Resolve course.json `targetRepo` (relative to the workspace) to an absolute path. */
export function resolveCourseTargetRepo(courseDir: string, targetRepo: string): string {
  const override = process.env[TARGET_REPO_ENV]
  if (override) return path.resolve(override)
  return path.resolve(courseDir, targetRepo)
}

function relativeTargetPath(outDir: string, targetRepo: string): string {
  const rel = path.relative(outDir, targetRepo)
  // On Windows a different drive yields an absolute path; nothing portable is possible then.
  return path.isAbsolute(rel) ? rel : rel.split(path.sep).join('/') || '.'
}

export async function runInit(
  options: InitOptions,
): Promise<{ outDir: string; course: CourseJson }> {
  const languages = validateLanguages(options.languages)
  const targetRepo = resolveTargetRepo(options.targetRepo)
  const pinnedCommit = readHeadCommit(targetRepo)
  const outDir = path.resolve(options.outDir ?? defaultOutDir(targetRepo, options.cwd))

  if (existsSync(outDir) && requireNotEmpty(outDir)) {
    throw new Error(`Output directory already exists and is not empty: ${outDir}`)
  }

  const existedBefore = existsSync(outDir)
  mkdirSync(outDir, { recursive: true })

  try {
    const templateRoot = templatesDir()
    cpSync(templateRoot, outDir, { recursive: true })
    // npm never packs files named .gitignore, so the template ships it as `gitignore`.
    renameSync(path.join(outDir, 'gitignore'), path.join(outDir, '.gitignore'))

    writeLessonPlaceholders(outDir, languages)
    writeAudioTree(outDir)

    const targetRel = relativeTargetPath(outDir, targetRepo)
    const targetRemote = readShareableRemote(targetRepo)
    const course: CourseJson = {
      schemaVersion: 1,
      targetRepo: targetRel,
      targetRemote,
      pinnedCommit,
      languages,
      referenceMode: options.submodule ? 'submodule' : 'pinned-path',
      submodulePath: options.submodule ? SUBMODULE_PATH : null,
    }
    writeCourseJson(outDir, course)

    if (options.submodule) {
      initGitRepo(outDir)
      addSubmodule(outDir, targetRepo, SUBMODULE_PATH, targetRemote ?? targetRel)
      checkoutSubmoduleCommit(outDir, SUBMODULE_PATH, pinnedCommit)
    }

    return { outDir, course }
  } catch (err) {
    // Do not leave a half-written workspace behind; it would block a re-run.
    if (existedBefore) {
      for (const entry of readdirSync(outDir)) {
        rmSync(path.join(outDir, entry), { recursive: true, force: true })
      }
    } else {
      rmSync(outDir, { recursive: true, force: true })
    }
    throw err
  }
}

function requireNotEmpty(dir: string): boolean {
  return readdirSync(dir).length > 0
}
