export const PACK_LIMITS = {
  maxFileBytes: 100_000,
  maxLinesPerFile: 400,
  maxTreePathsListed: 400,
  maxSelectedFiles: 40,
  maxDocExcerptLines: 80,
  maxLogEntries: 25,
  maxExcerptChars: 12_000,
} as const

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
