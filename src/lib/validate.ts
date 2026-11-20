import path from 'node:path'

/**
 * Input validation shared by CLI flags and config files. Anything that becomes a path segment or
 * YAML value must pass these checks first.
 */

/** BCP 47-ish language code: `pl`, `en`, `pt-br`, `zh-hant`. Lowercase only. */
export const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/

export function validateLanguage(code: string): string {
  if (typeof code !== 'string' || !LANGUAGE_RE.test(code)) {
    throw new Error(
      `Invalid language code ${JSON.stringify(code)} (expected e.g. "pl", "en" or "pt-br")`,
    )
  }
  return code
}

export function validateLanguages(codes: unknown): string[] {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('At least one language is required (e.g. pl,en)')
  }
  return [...new Set(codes.map((c) => validateLanguage(c as string)))]
}

/** Lesson ids are single path segments: letters, digits, dots and hyphens, starting alphanumeric. */
export const LESSON_ID_RE = /^[a-z0-9][a-z0-9.-]{0,99}$/i

export function validateLessonId(id: string): string {
  if (typeof id !== 'string' || !LESSON_ID_RE.test(id)) {
    throw new Error(
      `Invalid lesson id ${JSON.stringify(id)} (use letters, numbers, dots and hyphens, e.g. 02-invoices)`,
    )
  }
  return id
}

/** Throw unless `target` is `base` itself or lies inside it (after resolving `..`). */
export function assertInside(base: string, target: string, what: string): void {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${what} escapes ${base}: ${target}`)
  }
}

/** A repo-relative POSIX path or glob: no absolute paths, backslashes or `..` segments. */
export function validateRepoPattern(pattern: unknown, what: string): string {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new Error(`${what} must be a non-empty string`)
  }
  const p = pattern.trim()
  if (p.startsWith('/') || /^[a-z]:/i.test(p) || p.includes('\\') || p.split('/').includes('..')) {
    throw new Error(`${what} must be relative to the target repo root without "..": ${pattern}`)
  }
  return p
}

/** A relative workspace path such as `target-repo` (no `..`, not absolute). */
export function validateRelativeDir(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !/^[\w.-]+(\/[\w.-]+)*$/.test(value) ||
    value.split('/').some((seg) => seg === '..' || seg === '.')
  ) {
    throw new Error(`${what} must be a relative directory inside the workspace: ${String(value)}`)
  }
  return value
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readJsonFile(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
