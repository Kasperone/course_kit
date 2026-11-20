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
