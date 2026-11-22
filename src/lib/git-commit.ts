import { execFileSync } from 'node:child_process'
import { childEnv } from './child-env.js'
import { FULL_SHA_RE, GIT_HARDENING_ARGS, GIT_TIMEOUT_MS, requireModernGit } from './git.js'

/**
 * Read-only access to a target repository at a pinned commit, via the object database only.
 *
 * Hardening rules for every call:
 * - revisions must be full SHAs and are passed after `--end-of-options`;
 * - paths are parsed from NUL-separated output (`-z`), so quoting and non-ASCII names are safe;
 * - pathspecs are literal (`--literal-pathspecs`), so file names are never pathspec magic;
 * - stderr is captured, never printed to the user's terminal;
 * - config that can run programs is pinned on the command line, which overrides repository config
 *   (`GIT_HARDENING_ARGS`): implicit bare repositories are refused (a shared workspace could commit
 *   a bare repo's files and make it the target), signatures are never verified (no `gpg.program`),
 *   and no fsmonitor hook runs;
 * - git runs with an allowlisted environment (`childEnv()`), so no API key reaches it or its hooks.
 */

export type TreeEntry = {
  mode: string
  type: 'blob' | 'commit' | 'tree'
  oid: string
  /** Blob size in bytes; null for submodule (gitlink) entries. */
  size: number | null
  path: string
  /** True for symlinks (mode 120000): content is the link text, never the linked file. */
  symlink: boolean
}

const BASE_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c',
  'core.quotePath=false',
  ...GIT_HARDENING_ARGS,
]

function git(repo: string, args: string[], opts: { input?: string; maxBuffer?: number } = {}) {
  requireModernGit()
  return execFileSync('git', [...BASE_ARGS, '-C', repo, ...args], {
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A read of a large repository is still seconds; a hung git must not hang us.
    timeout: GIT_TIMEOUT_MS,
    env: childEnv(),
  })
}

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr
  const text = stderr ? String(stderr).trim() : ''
  return text || (err instanceof Error ? err.message : String(err))
}

export function assertFullSha(commit: string): void {
  if (!FULL_SHA_RE.test(commit)) {
    throw new Error(`Not a full commit SHA: ${JSON.stringify(commit)}`)
  }
}

/** Fail with an actionable message if the pinned commit is not present in `repo`. */
export function verifyCommit(repo: string, commit: string): void {
  assertFullSha(commit)
  try {
    git(repo, ['cat-file', '-e', '--end-of-options', `${commit}^{commit}`])
  } catch (err) {
    throw new Error(
      `Pinned commit ${commit} is not available in ${repo} (${stderrOf(err)}). ` +
        'Fetch it, point COURSE_TARGET_REPO at a clone that has it, or re-pin the course.',
    )
  }
}

/** Every entry of the commit's tree (recursive), with sizes, from a single git process. */
export function listTreeAtCommit(repo: string, commit: string): TreeEntry[] {
  assertFullSha(commit)
  const out = git(repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', '--end-of-options', commit])
  const entries: TreeEntry[] = []
  for (const record of out.toString('utf8').split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const meta = record.slice(0, tab).trim().split(/\s+/)
    const [mode, type, oid, size] = meta as [string, TreeEntry['type'], string, string]
    entries.push({
      mode,
      type,
      oid,
      size: size === '-' ? null : Number(size),
      path: record.slice(tab + 1),
      symlink: mode === '120000',
    })
  }
  return entries
}

/**
 * Read many blobs with one `git cat-file --batch` process, keyed by object id. Missing objects are
 * omitted. Callers filter by size first; the output buffer is sized from the entries' sizes.
 */
export function readBlobs(
  repo: string,
  entries: Array<Pick<TreeEntry, 'oid' | 'size'>>,
): Map<string, Buffer> {
  const sizes = new Map(entries.map((e) => [e.oid, e.size ?? 0]))
  const result = new Map<string, Buffer>()
  if (sizes.size === 0) return result
  for (const oid of sizes.keys()) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) throw new Error(`Bad object id: ${oid}`)
  }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0)
  const out = git(repo, ['cat-file', '--batch'], {
    input: [...sizes.keys()].join('\n') + '\n',
    maxBuffer: total + sizes.size * 128 + 1024,
  })
  let pos = 0
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos)
    if (nl < 0) break
    const header = out.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    const parts = header.split(' ')
    if (parts[1] === 'missing' || parts.length < 3) continue
    const size = Number(parts[2])
    result.set(parts[0]!, Buffer.from(out.subarray(pos, pos + size)))
    pos += size + 1 // content is followed by a newline
  }
  return result
}

/** Decode a blob as UTF-8 text, or null if it looks binary (NUL byte). */
export function blobToText(buf: Buffer | undefined): string | null {
  if (!buf) return null
  if (buf.includes(0)) return null
  return buf.toString('utf8')
}

export type GitLog = { entries: string[]; error: string | null }

/**
 * Recent commits that touched `paths`. A failure (timeout, a path list too long for the command
 * line) is returned, not hidden: the pack then says the history is missing instead of claiming
 * there are no entries.
 */
export function logTouchingPaths(
  repo: string,
  commit: string,
  paths: string[],
  maxEntries: number,
): GitLog {
  if (paths.length === 0) return { entries: [], error: null }
  assertFullSha(commit)
  const args = [
    'log',
    '-n',
    String(maxEntries),
    '--format=%h %an %ad %s',
    '--date=short',
    '--end-of-options',
    commit,
    '--',
    ...paths,
  ]
  try {
    const entries = git(repo, args)
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    return { entries, error: null }
  } catch (err) {
    return { entries: [], error: stderrOf(err) }
  }
}
