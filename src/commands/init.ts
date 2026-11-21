import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addSubmodule,
  checkoutSubmoduleCommit,
  initGitRepo,
  isCommitOnRemoteBranch,
  readHeadCommit,
  readShareableRemote,
  resolveTargetRepo,
} from '../lib/git.js'
import { defaultLessonJson, writeLessonJson, writePlaceholderSlides } from '../lib/lesson.js'
import { defaultOutDir, templatesDir } from '../lib/paths.js'
import { validateLanguages } from '../lib/validate.js'

export const SUBMODULE_PATH = 'target-repo'

export { PLANTUML_DISABLED_SERVER } from '../lib/slidev.js'

export type CourseJson = {
  schemaVersion: 1
  /**
   * Path to the target repository, relative to the workspace directory (POSIX separators), so the
   * file never contains a machine-specific absolute path. null when no such path exists without
   * revealing the local layout (e.g. workspace in /tmp, target in $HOME); the path then lives in
   * the gitignored course.local.json. Override locally with COURSE_TARGET_REPO.
   */
  targetRepo: string | null
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

/** Env var that overrides course.json `targetRepo` on this machine (absolute or cwd-relative). */
export const TARGET_REPO_ENV = 'COURSE_TARGET_REPO'

/** Machine-local, gitignored settings; holds the absolute target path when no portable one exists. */
export const LOCAL_CONFIG_FILE = 'course.local.json'

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** The home directory as written and as resolved: either may appear in a physical path. */
export function homeDirs(home: string = os.homedir()): string[] {
  if (!home) return []
  try {
    const real = realpathSync(home)
    return real === path.resolve(home) ? [home] : [home, real]
  } catch {
    return [home]
  }
}

/**
 * Workspace-relative path to the target, or null if any relative path would expose the local
 * layout: different drives, only the filesystem root in common, or a target inside the home
 * directory reached from outside it (`../../home/<user>/...`). Pass physical paths (realpath):
 * a relative path between symlinked spellings can point somewhere else on disk.
 */
export function portableRelativePath(
  fromDir: string,
  toDir: string,
  homes: string | string[] = homeDirs(),
): string | null {
  const from = path.resolve(fromDir)
  const to = path.resolve(toDir)
  const rootFrom = path.parse(from).root
  if (rootFrom !== path.parse(to).root) return null
  const firstSeg = (p: string) => p.slice(rootFrom.length).split(path.sep)[0]
  if (firstSeg(from) !== firstSeg(to)) return null
  const inHome = (p: string) => [homes].flat().some((h) => h && isInside(p, path.resolve(h)))
  if (inHome(to) && !inHome(from)) return null
  return path.relative(from, to).split(path.sep).join('/') || '.'
}

function readLocalTargetRepo(courseDir: string): string | null {
  const file = path.join(courseDir, LOCAL_CONFIG_FILE)
  if (!existsSync(file)) return null
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  const target = (data as { targetRepo?: unknown } | null)?.targetRepo
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error(`${file}: "targetRepo" must be an absolute path`)
  }
  return target
}

/**
 * Absolute target path for a workspace: COURSE_TARGET_REPO, then course.local.json, then
 * course.json `targetRepo` resolved against the workspace's physical directory (the one init
 * computed it from), so a workspace reached through a symlink still finds its target.
 */
export function resolveCourseTargetRepo(courseDir: string, targetRepo: string | null): string {
  const override = process.env[TARGET_REPO_ENV]
  if (override) return path.resolve(override)
  const local = readLocalTargetRepo(courseDir)
  if (local) return local
  if (targetRepo) return path.resolve(physicalDir(courseDir), targetRepo)
  throw new Error(
    `No target repo path for ${courseDir}: set ${TARGET_REPO_ENV} or create ${LOCAL_CONFIG_FILE} with {"targetRepo": "/abs/path"}`,
  )
}

function physicalDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

export async function runInit(
  options: InitOptions,
): Promise<{ outDir: string; course: CourseJson; notices: string[] }> {
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

    // targetRepo is git's physical top level; compare it with the physical workspace directory.
    const targetRel = portableRelativePath(realpathSync(outDir), targetRepo)
    const targetRemote = readShareableRemote(targetRepo)
    const notices: string[] = []
    if (targetRel === null) {
      notices.push(
        `course.json has no portable target path; this machine's path is in ${LOCAL_CONFIG_FILE} (gitignored). ` +
          `Collaborators set ${TARGET_REPO_ENV} or create their own ${LOCAL_CONFIG_FILE}.`,
      )
      writeFileSync(
        path.join(outDir, LOCAL_CONFIG_FILE),
        JSON.stringify({ targetRepo }, null, 2) + '\n',
        'utf8',
      )
    }
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
      const submoduleUrl = targetRemote ?? targetRel
      if (!submoduleUrl) {
        throw new Error(
          '--submodule needs a target with a network origin remote, or a workspace next to the target (e.g. --out ../<name>-course)',
        )
      }
      initGitRepo(outDir)
      addSubmodule(outDir, targetRepo, SUBMODULE_PATH, submoduleUrl)
      checkoutSubmoduleCommit(outDir, SUBMODULE_PATH, pinnedCommit)
      if (submoduleUrl === targetRemote && !isCommitOnRemoteBranch(targetRepo, pinnedCommit)) {
        notices.push(
          `Pinned commit ${pinnedCommit} is on no remote-tracking branch of the target: push it, ` +
            `or \`git submodule update\` will fail for anyone who clones this course.`,
        )
      }
    }

    return { outDir, course, notices }
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
