import { createReadStream, lstatSync, type Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

/**
 * Static files from a built course (dist/: decks, narration clips, index.html) for `course serve`.
 * Only GET/HEAD, no path traversal (`..`, encoded or not), no backslashes or NUL, and no symlinks
 * anywhere below the root. Single byte ranges are supported so audio can seek.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

/** lstat every component below `root`; null if missing or if any component is a symlink. */
function safeStat(root: string, segments: string[]): Stats | null {
  let current = root
  let st: Stats | null = null
  for (const seg of segments) {
    current = path.join(current, seg)
    try {
      st = lstatSync(current)
    } catch {
      return null
    }
    if (st.isSymbolicLink()) return null
  }
  if (st === null) {
    try {
      st = lstatSync(root)
    } catch {
      return null
    }
  }
  return st
}

/** Parse a single `bytes=a-b` range; null for none, 'invalid' when unsatisfiable. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed')
  const rawPath = (req.url ?? '/').split('?')[0]!
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return send(res, 400, 'Bad request')
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return send(res, 400, 'Bad request')
  const segments = decoded.split('/').filter(Boolean)
  if (segments.some((s) => s === '..' || s === '.')) return send(res, 400, 'Bad request')
  const target = path.join(root, ...segments)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 400, 'Bad request')

  let st = safeStat(root, segments)
  if (!st) return send(res, 404, 'Not found')
  let file = target
  if (st.isDirectory()) {
    if (!rawPath.endsWith('/')) {
      // Decks use relative asset paths: /<lesson>/<lang> must become /<lesson>/<lang>/.
      // Built from the validated segments, so the target is always a local path.
      res.writeHead(301, { Location: `/${segments.map(encodeURIComponent).join('/')}/` })
      return void res.end()
    }
    st = safeStat(root, [...segments, 'index.html'])
    if (!st) return send(res, 404, 'Not found')
    file = path.join(target, 'index.html')
  }
  if (!st.isFile()) return send(res, 404, 'Not found')

  const ext = path.extname(file).toLowerCase()
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  }
  const range = parseRange(req.headers.range, st.size)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
    return void res.end()
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
      'Content-Length': range.end - range.start + 1,
    })
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size })
  }
  if (req.method === 'HEAD') return void res.end()
  createReadStream(file, range ? { start: range.start, end: range.end } : {}).pipe(res)
}
