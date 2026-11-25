import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'course-kit'

export function defaultOutDir(targetRepo: string, cwd: string = process.cwd()): string {
  const base = path.basename(targetRepo)
  const safe = base.replace(/[^\w.-]+/g, '-') || 'repo'
  return path.join(cwd, `${safe}-course`)
}

/**
 * Locate the course-kit package root by walking up from this module until a package.json named
 * `course-kit` is found. Works for `src/lib/*.ts` (tsx/vitest) and the bundled `dist/cli.js`.
 */
export function packageRoot(
  startDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = startDir
  for (;;) {
    const pkgPath = path.join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (pkg.name === PACKAGE_NAME) return dir
      } catch {
        // ignore unreadable package.json and keep walking up
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not locate the ${PACKAGE_NAME} package root from ${startDir}`)
    }
    dir = parent
  }
}

export function templatesDir(): string {
  return path.join(packageRoot(), 'templates', 'workspace')
}
