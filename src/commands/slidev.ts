import { spawn, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { CourseJson } from './init.js'
import { assertNoSymlinkBelow, writeFileInside } from '../lib/fs-safe.js'
import {
  findForbiddenBuildRefs,
  findPlantUmlFiles,
  findWebFontFiles,
  offlineHeadmatterProblems,
} from '../lib/slidev.js'
import { assertInside, isPlainObject, validateLanguage, validateLessonId } from '../lib/validate.js'
import { lessonDir, resolveWorkspaceConfig } from '../lib/workspace.js'

export type Deck = {
  lessonId: string
  lang: string
  /** Absolute path of lessons/<id>/<lang>/slides.md. */
  entry: string
  /** Absolute output directory: dist/<id>/<lang>. */
  outDir: string
  /** URL base for the built deck: /<id>/<lang>/. */
  base: string
}

export type DeckFilter = { lesson?: string; lang?: string }

/** Workspace-relative build output root. */
export const BUILD_DIR = 'dist'

/** Every lesson deck in the workspace (lessons/<id>/<lang>/slides.md for the course languages). */
export function listDecks(courseDir: string, course: CourseJson, filter: DeckFilter = {}): Deck[] {
  if (filter.lesson) validateLessonId(filter.lesson)
  if (filter.lang) {
    validateLanguage(filter.lang)
    if (!course.languages.includes(filter.lang)) {
      throw new Error(
        `Language "${filter.lang}" is not in course.json languages (${course.languages.join(', ')})`,
      )
    }
  }
  const lessonsRoot = path.join(courseDir, 'lessons')
  const ids = filter.lesson
    ? [filter.lesson]
    : existsSync(lessonsRoot)
      ? readdirSync(lessonsRoot)
          .filter((id) => {
            try {
              validateLessonId(id)
            } catch {
              return false
            }
            const st = lstatSync(path.join(lessonsRoot, id))
            return st.isDirectory() && !st.isSymbolicLink()
          })
          .sort()
      : []
  const langs = filter.lang ? [filter.lang] : course.languages
  const decks: Deck[] = []
  for (const lessonId of ids) {
    const root = lessonDir(courseDir, lessonId)
    if (filter.lesson && !existsSync(root)) {
      throw new Error(`Unknown lesson "${lessonId}" (expected ${root})`)
    }
    for (const lang of langs) {
      const entry = path.join(root, lang, 'slides.md')
      if (!existsSync(entry)) continue
      assertNoSymlinkBelow(courseDir, entry, 'Deck')
      decks.push({
        lessonId,
        lang,
        entry,
        outDir: path.join(courseDir, BUILD_DIR, lessonId, lang),
        base: `/${lessonId}/${lang}/`,
      })
    }
  }
  if (decks.length === 0) {
    const what = [filter.lesson, filter.lang].filter(Boolean).join('/')
    throw new Error(`No lesson decks found${what ? ` for ${what}` : ''} under ${lessonsRoot}`)
  }
  return decks
}

/**
 * The workspace's own Slidev CLI script (node_modules/@slidev/cli), run with the current Node
 * binary, so no shell and no `.cmd` shims are involved. Slidev stays a workspace dependency.
 */
export function slidevBin(courseDir: string): string {
  const pkgDir = path.join(courseDir, 'node_modules', '@slidev', 'cli')
  const pkgFile = path.join(pkgDir, 'package.json')
  if (!existsSync(pkgFile)) {
    throw new Error(`Slidev is not installed in ${courseDir}. Run \`npm install\` there first.`)
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { bin?: unknown }
  const rel =
    typeof pkg.bin === 'string' ? pkg.bin : isPlainObject(pkg.bin) ? pkg.bin.slidev : undefined
  if (typeof rel !== 'string') throw new Error(`${pkgFile} has no "slidev" bin entry`)
  const bin = path.resolve(pkgDir, rel)
  assertInside(pkgDir, bin, 'Slidev bin')
  return bin
}

/**
 * Refuse to start Slidev unless every deck stays offline and export-free: no PlantUML (the
 * diagram source would go to a PlantUML server), no web-font CDN references, and each entry
 * deck's headmatter pins the data: PlantUML server, system fonts, and no browser exporter/download.
 */
export function assertDeckPolicy(courseDir: string, decks: Deck[]): void {
  const errors: string[] = []
  const plantUml = findPlantUmlFiles(courseDir)
  if (plantUml.length > 0) {
    errors.push(
      `PlantUML is not allowed (Slidev would send the diagram source to a PlantUML server); use Mermaid. Offending files: ${plantUml.join(', ')}`,
    )
  }
  const fonts = findWebFontFiles(courseDir)
  if (fonts.length > 0) {
    errors.push(
      `Web fonts from a CDN are not allowed (decks use system fonts and stay offline). Offending files: ${fonts.join(', ')}`,
    )
  }
  for (const deck of decks) {
    const problems = offlineHeadmatterProblems(readFileSync(deck.entry, 'utf8'))
    if (problems.length > 0) {
      const rel = path.relative(courseDir, deck.entry).split(path.sep).join('/')
      errors.push(`${rel} headmatter: ${problems.join('; ')}`)
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
}

export type SlidevRunner = (bin: string, args: string[], cwd: string) => void

const defaultRunner: SlidevRunner = (bin, args, cwd) => {
  execFileSync(process.execPath, [bin, ...args], { cwd, stdio: 'inherit' })
}

export type BuildOptions = DeckFilter & { cwd?: string; runner?: SlidevRunner }

export type BuildResult = { courseDir: string; distDir: string; decks: Deck[]; index: string }

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function deckTitle(entry: string, fallback: string): string {
  const m = readFileSync(entry, 'utf8').match(/^---\r?\n[\s\S]*?^title:\s*(.+?)\s*$/m)
  if (!m) return fallback
  const raw = m[1]!
  try {
    return raw.startsWith('"') ? String(JSON.parse(raw)) : raw.replace(/^'(.*)'$/, '$1')
  } catch {
    return raw
  }
}

function indexHtml(decks: Deck[]): string {
  const items = decks
    .map(
      (d) =>
        `      <li><a href="./${encodeURIComponent(d.lessonId)}/${encodeURIComponent(d.lang)}/">${escapeHtml(
          deckTitle(d.entry, d.lessonId),
        )}</a> <small>(${escapeHtml(d.lessonId)}, ${escapeHtml(d.lang)})</small></li>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Course decks</title>
  </head>
  <body>
    <h1>Course decks</h1>
    <ul>
${items}
    </ul>
    <p>Serve this directory from its root, e.g. <code>npx vite preview --outDir dist</code>.</p>
  </body>
</html>
`
}

/**
 * `course build`: static Slidev build of every lesson deck into dist/<id>/<lang>/ plus a
 * dist/index.html, after the deck policy check. The output is then scanned for PlantUML servers
 * and web-font CDNs.
 */
export function runBuild(options: BuildOptions = {}): BuildResult {
  const { courseDir, course } = resolveWorkspaceConfig(options.cwd)
  const decks = listDecks(courseDir, course, options)
  assertDeckPolicy(courseDir, decks)
  const bin = slidevBin(courseDir)
  const runner = options.runner ?? defaultRunner
  const distDir = path.join(courseDir, BUILD_DIR)

  for (const deck of decks) {
    assertNoSymlinkBelow(courseDir, deck.outDir, 'Build output')
    rmSync(deck.outDir, { recursive: true, force: true })
    runner(
      bin,
      ['build', deck.entry, '--out', deck.outDir, '--base', deck.base, '--router-mode', 'hash'],
      courseDir,
    )
    if (!existsSync(path.join(deck.outDir, 'index.html'))) {
      throw new Error(`Slidev did not produce ${path.join(deck.outDir, 'index.html')}`)
    }
  }

  // Render-time check: nothing in the built output may point at a PlantUML server or font CDN.
  const leaks = decks.flatMap((d) => findForbiddenBuildRefs(d.outDir))
  if (leaks.length > 0) {
    throw new Error(
      `Built output references external servers: ${leaks
        .map((l) => `${path.relative(courseDir, l.file)} (${l.what})`)
        .join(', ')}`,
    )
  }

  // The index lists every deck present in dist/, so a filtered build keeps earlier decks linked.
  const built = listDecks(courseDir, course).filter((d) =>
    existsSync(path.join(d.outDir, 'index.html')),
  )
  const index = path.join(distDir, 'index.html')
  writeFileInside(courseDir, index, indexHtml(built))
  return { courseDir, distDir, decks, index }
}

export type DevOptions = { lesson: string; lang?: string; port?: number; cwd?: string }

/** `course dev`: live preview of one lesson deck (Slidev dev server on localhost). */
export function runDev(options: DevOptions): Promise<number> {
  const { courseDir, course } = resolveWorkspaceConfig(options.cwd)
  const lang = options.lang ?? course.languages[0]!
  const [deck] = listDecks(courseDir, course, { lesson: options.lesson, lang })
  if (!deck) throw new Error(`No deck for ${options.lesson}/${lang}`)
  assertDeckPolicy(courseDir, [deck])
  const bin = slidevBin(courseDir)
  const args = [deck.entry]
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new Error(`Invalid port ${String(options.port)}`)
    }
    args.push('--port', String(options.port))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: courseDir, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}
