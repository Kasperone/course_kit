export type PackLimits = {
  /** Skip files larger than this many bytes. */
  maxFileBytes: number
  /** Show at most this many lines per file. */
  maxLinesPerFile: number
  /** List at most this many paths in the tree summary. */
  maxTreePathsListed: number
  /** Include at most this many selected files; the rest are reported as over the cap. */
  maxSelectedFiles: number
  /** Include at most this many related test files. */
  maxRelatedTests: number
  /** README/AGENTS.md/CLAUDE.md excerpt length. */
  maxDocExcerptLines: number
  /** Git log entries for the selected paths. */
  maxLogEntries: number
}

export const PACK_LIMITS: Readonly<PackLimits> = Object.freeze({
  maxFileBytes: 100_000,
  maxLinesPerFile: 400,
  maxTreePathsListed: 400,
  maxSelectedFiles: 40,
  maxRelatedTests: 20,
  maxDocExcerptLines: 80,
  maxLogEntries: 25,
})

export const LIMIT_KEYS = Object.keys(PACK_LIMITS) as Array<keyof PackLimits>

const LIMIT_CEILING = 10_000_000

/** Validate `limits` from lesson.json (partial, positive integers, known keys only). */
export function parseLimitOverrides(value: unknown, file: string): Partial<PackLimits> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file}: "limits" must be an object`)
  }
  const out: Partial<PackLimits> = {}
  for (const [key, v] of Object.entries(value)) {
    if (!(LIMIT_KEYS as string[]).includes(key)) {
      throw new Error(
        `${file}: unknown limit ${JSON.stringify(key)} (known: ${LIMIT_KEYS.join(', ')})`,
      )
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > LIMIT_CEILING) {
      throw new Error(`${file}: limits.${key} must be a positive integer`)
    }
    out[key as keyof PackLimits] = v
  }
  return out
}

export function resolveLimits(overrides: Partial<PackLimits> = {}): PackLimits {
  return { ...PACK_LIMITS, ...overrides }
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.jar',
  '.war',
  '.ear',
  '.class',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.bin',
  '.dat',
])

export function isProbablyBinaryPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}
