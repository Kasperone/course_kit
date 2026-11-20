import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import path from 'node:path'
import { assertInside } from './validate.js'

/**
 * Symlink-safe writes inside a course workspace. A shared or cloned workspace could contain a
 * symlink such as `lessons/x/context-pack.md -> ~/.bashrc` or `lessons -> /etc`; writing through
 * it would modify files outside the workspace. Every helper here refuses to traverse or replace a
 * symlink below `base`. `base` itself may be a symlink (the user chose that path).
 */

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false // does not exist (yet)
  }
}

/** Throw if `target` is outside `base` or any existing path component below `base` is a symlink. */
export function assertNoSymlinkBelow(base: string, target: string, what = 'Path'): void {
  const root = path.resolve(base)
  const abs = path.resolve(target)
  assertInside(root, abs, what)
  const rel = path.relative(root, abs)
  if (rel === '') return
  let current = root
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment)
    if (isSymlink(current)) {
      throw new Error(`${what} goes through a symlink, refusing to write: ${current}`)
    }
  }
}

/** `mkdir -p` that refuses symlinked components below `base`. */
export function mkdirInside(base: string, dir: string): void {
  assertNoSymlinkBelow(base, dir, 'Directory')
  mkdirSync(dir, { recursive: true })
  // Re-check: a component created concurrently could be a symlink.
  assertNoSymlinkBelow(base, dir, 'Directory')
}

/**
 * Write a file without following a symlink at the final component (O_NOFOLLOW where the platform
 * has it). Use writeFileInside for paths inside the workspace.
 */
export function writeFileNoFollow(file: string, data: string | Buffer): void {
  if (isSymlink(file)) throw new Error(`Refusing to write through a symlink: ${file}`)
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
    0o644,
  )
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let offset = 0
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset)
  } finally {
    closeSync(fd)
  }
}

/** Write `file` (which must be inside `base`), creating parent directories, never via symlinks. */
export function writeFileInside(base: string, file: string, data: string | Buffer): void {
  mkdirInside(base, path.dirname(file))
  assertNoSymlinkBelow(base, file, 'File')
  writeFileNoFollow(file, data)
}
