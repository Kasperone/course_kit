import { spawn, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { CourseJson } from './init.js'
import { childEnv } from '../lib/child-env.js'
import { escapeControls } from '../lib/context-pack/markdown.js'
import { assertNoSymlinkBelow, writeFileInside } from '../lib/fs-safe.js'
import { MANIFEST_FILE, parseManifest } from '../lib/narration/manifest.js'
import {
  findExternalUrlFiles,
  findForbiddenBuildRefs,
  findPlantUmlFiles,
  findOutsideImports,
  findRemoteAssetFiles,
  findWebFontFiles,
  headmatterValue,
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
  // File names come from the workspace, which can be a clone of someone else's: one line per error.
  const list = (files: string[]) => files.map(escapeControls).join(', ')
  const plantUml = findPlantUmlFiles(courseDir)
  if (plantUml.length > 0) {
    errors.push(
      `PlantUML is not allowed (Slidev would send the diagram source to a PlantUML server); use Mermaid. Offending files: ${list(plantUml)}`,
    )
  }
  const fonts = findWebFontFiles(courseDir)
  if (fonts.length > 0) {
    errors.push(
      `Web fonts from a CDN are not allowed (decks use system fonts and stay offline). Offending files: ${list(fonts)}`,
    )
  }
  const external = findExternalUrlFiles(courseDir)
  if (external.length > 0) {
    errors.push(
      `Deck code (Vue/TS/JS) must not reference external URLs (decks stay offline; only localhost is allowed). Offending files: ${list(external)}`,
    )
  }
  const remote = findRemoteAssetFiles(courseDir)
  if (remote.length > 0) {
    errors.push(
      `Remote images, embeds, scripts and styles are not allowed (decks make no requests beyond the local server; plain links are fine). Offending files: ${list(remote)}`,
    )
  }
  const imports = findOutsideImports(courseDir)
  if (imports.length > 0) {
    errors.push(
      `Slide imports (src: and <<< snippets) must stay inside the workspace's scanned files: no absolute paths, symlinks, node_modules/, dist/, audio/ or target-repo/, no context packs or secret-looking files (.env*, keys), no PlantUML snippets: ${list(imports)}`,
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

/**
 * Slidev, its theme and addons, and the workspace code it loads (`vite.config.*`, `setup/*`) run
 * with an allowlisted environment: an API key exported in the shell never reaches them. Node and
 * Vite settings (`NODE_*`, `VITE_*`, `SLIDEV_*`) and `DEBUG`/`BROWSER` still pass.
 */
const slidevEnv = () => childEnv({ extra: ['NODE_*', 'VITE_*', 'SLIDEV_*', 'DEBUG', 'BROWSER'] })

/** A stuck Vite build must not hang `course build`: a real deck builds in seconds to a minute. */
export const SLIDEV_BUILD_TIMEOUT_MS = 10 * 60_000

function timedRunner(timeoutMs: number): SlidevRunner {
  return (bin, args, cwd) => {
    try {
      execFileSync(process.execPath, [bin, ...args], {
        cwd,
        stdio: 'inherit',
        env: slidevEnv(),
        timeout: timeoutMs,
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error(
          `Slidev did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`,
        )
      }
      throw err
    }
  }
}

export type BuildOptions = DeckFilter & {
  cwd?: string
  runner?: SlidevRunner
  /** Copy narration clips next to the decks (default true). */
  narration?: boolean
  /** Build timeout per deck (default: SLIDEV_BUILD_TIMEOUT_MS). */
  timeoutMs?: number
}

export type NarrationCopy = { lessonId: string; lang: string; clips: number; dir: string }

export type BuildResult = {
  courseDir: string
  distDir: string
  decks: Deck[]
  index: string
  narration: NarrationCopy[]
}

/**
 * Copy each built lesson's narration (audio/local/<lang>/<id>/manifest.json and the clips it lists)
 * to dist/<id>/narration/<lang>/, where the player in every language deck of that lesson finds it
 * (../narration/<lang>/ from the deck base). Only validated clip names are copied; symlinks are
 * never followed. All course languages are copied so the player can switch narration language.
 */
export function copyNarration(
  courseDir: string,
  lessonIds: string[],
  languages: string[],
): NarrationCopy[] {
  const copied: NarrationCopy[] = []
  for (const lessonId of [...new Set(lessonIds)]) {
    const target = path.join(courseDir, BUILD_DIR, lessonId, 'narration')
    assertNoSymlinkBelow(courseDir, target, 'Build output')
    rmSync(target, { recursive: true, force: true })
    for (const lang of languages) {
      const src = path.join(courseDir, 'audio', 'local', lang, lessonId)
      const manifestFile = path.join(src, MANIFEST_FILE)
      if (!existsSync(manifestFile)) continue
      assertNoSymlinkBelow(courseDir, manifestFile, 'Narration manifest')
      const manifest = parseManifest(
        JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown,
        path.relative(courseDir, manifestFile),
      )
      const dir = path.join(target, lang)
      for (const clip of manifest.clips) {
        const from = path.join(src, clip.file)
        const st = existsSync(from) ? lstatSync(from) : null
        if (!st?.isFile())
          throw new Error(
            `Narration clip missing: ${path.relative(courseDir, from)} (run course narrate ${lessonId} --lang ${lang})`,
          )
        writeFileInside(courseDir, path.join(dir, clip.file), readFileSync(from))
      }
      writeFileInside(
        courseDir,
        path.join(dir, MANIFEST_FILE),
        JSON.stringify(manifest, null, 2) + '\n',
      )
      copied.push({ lessonId, lang, clips: manifest.clips.length, dir })
    }
  }
  return copied
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

/** The deck's headmatter `title` (never a `title:` from a later slide or a code sample). */
function deckTitle(entry: string, fallback: string): string {
  const raw = headmatterValue(readFileSync(entry, 'utf8'), 'title')
  if (!raw) return fallback
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
  const runner = options.runner ?? timedRunner(options.timeoutMs ?? SLIDEV_BUILD_TIMEOUT_MS)
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
        .map((l) => `${escapeControls(path.relative(courseDir, l.file))} (${l.what})`)
        .join(', ')}`,
    )
  }

  const narration =
    options.narration === false
      ? []
      : copyNarration(
          courseDir,
          decks.map((d) => d.lessonId),
          course.languages,
        )

  // The index lists every deck present in dist/, so a filtered build keeps earlier decks linked.
  const built = listDecks(courseDir, course).filter((d) =>
    existsSync(path.join(d.outDir, 'index.html')),
  )
  const index = path.join(distDir, 'index.html')
  writeFileInside(courseDir, index, indexHtml(built))
  return { courseDir, distDir, decks, index, narration }
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
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: courseDir,
      stdio: 'inherit',
      env: slidevEnv(),
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}
