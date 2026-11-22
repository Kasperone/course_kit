import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { childEnv } from './child-env.js'
import { escapeControls } from './context-pack/markdown.js'

/** Full SHA-1 (40 hex) or SHA-256 (64 hex) object name. */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Config that can make git run programs is pinned on the command line, which overrides repository
 * config: implicit bare repositories are refused (a planted bare repo next to or inside a workspace
 * could otherwise be picked up as the target and run its `core.fsmonitor`/`gpg.program`), signatures
 * are never verified, and no fsmonitor hook runs. Every git call on a target repository uses these.
 * Filter drivers are not covered here because their names are only known per repository:
 * `repoFilterOverrides()` blanks them before the one command that can run them (`status`).
 */
export const GIT_HARDENING_ARGS = [
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'log.showSignature=false',
  '-c',
  'core.fsmonitor=false',
]

/** A hung git (e.g. a lock on NFS) must not hang the CLI. */
export const GIT_TIMEOUT_MS = 120_000

/** `safe.bareRepository` exists since git 2.38; older git silently ignores the unknown key. */
export const MIN_GIT_VERSION = [2, 38] as const

export function parseGitVersion(output: string): [number, number] | null {
  const m = output.match(/git version (\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2])] : null
}

export function assertGitVersion(output: string): void {
  const v = parseGitVersion(output)
  const [major, minor] = MIN_GIT_VERSION
  if (v && (v[0] > major || (v[0] === major && v[1] >= minor))) return
  throw new Error(
    `course_kit needs git >= ${major}.${minor} (found ${output.trim() || 'no version'}): older ` +
      'versions ignore the safe.bareRepository protection it relies on. Please upgrade git.',
  )
}

let gitVersionChecked = false

export function requireModernGit(): void {
  if (gitVersionChecked) return
  assertGitVersion(
    execFileSync('git', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
      timeout: GIT_TIMEOUT_MS,
    }),
  )
  gitVersionChecked = true
}

/** `git status` on a huge untracked tree outgrows execFileSync's default 1 MiB buffer. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/** Read-only git call on a target repository: hardened, no index refresh, never prompts. */
function gitRead(repoPath: string, args: string[], opts: { trim?: boolean } = {}): string {
  requireModernGit()
  const out = execFileSync(
    'git',
    [
      '--no-optional-locks',
      '-c',
      'core.quotePath=false',
      ...GIT_HARDENING_ARGS,
      '-C',
      repoPath,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    },
  )
  return opts.trim === false ? out : out.trim()
}

/** Git call that writes inside the workspace we are creating (`cwd`). */
function gitWrite(cwd: string, args: string[]): void {
  requireModernGit()
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: childEnv(),
    timeout: GIT_TIMEOUT_MS,
  })
}

function gitErrorDetail(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr
  const text = stderr ? String(stderr).trim() : ''
  return text || (err instanceof Error ? err.message : String(err))
}

/** Resolve a path inside a git working tree to the repository top level. */
export function resolveTargetRepo(repoPath: string): string {
  const resolved = path.resolve(repoPath)
  if (!existsSync(resolved)) {
    throw new Error(`Target path does not exist: ${resolved}`)
  }
  try {
    return path.resolve(gitRead(resolved, ['rev-parse', '--show-toplevel']))
  } catch (err) {
    throw new Error(`Target is not a git repository: ${resolved} (${gitErrorDetail(err)})`)
  }
}

export function readHeadCommit(repoPath: string): string {
  let hash: string
  try {
    hash = gitRead(repoPath, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
  } catch (err) {
    throw new Error(`Could not read HEAD commit from ${repoPath}: ${gitErrorDetail(err)}`)
  }
  if (!FULL_SHA_RE.test(hash)) {
    throw new Error(`Unexpected commit hash from ${repoPath}: ${JSON.stringify(hash)}`)
  }
  return hash
}

/** A revision a user may type: `HEAD`, a branch, tag or (short) SHA; never an option. */
const REV_RE = /^[\w./@^~{}+-]{1,200}$/

/**
 * Resolve a user-supplied revision (default HEAD) to a full commit SHA. The revision must exist
 * as a commit in `repoPath`; it is passed after `--end-of-options`, so it can never be an option.
 *
 * `preferOrigin` is for a submodule checkout, whose local branches are frozen at clone time while
 * `origin/*` moves with every fetch: `main` then means `refs/remotes/origin/main` if that exists,
 * and only otherwise the name as given (tags, SHAs, `origin/feature-x`).
 */
export function resolveCommit(
  repoPath: string,
  rev = 'HEAD',
  opts: { preferOrigin?: boolean } = {},
): string {
  if (!REV_RE.test(rev) || rev.startsWith('-') || rev.includes('..')) {
    throw new Error(`Invalid revision ${JSON.stringify(rev)}`)
  }
  const candidates = opts.preferOrigin ? [`refs/remotes/origin/${rev}`, rev] : [rev]
  let hash: string | null = null
  for (const candidate of candidates) {
    try {
      hash = gitRead(repoPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${candidate}^{commit}`,
      ])
      break
    } catch {
      // try the next spelling
    }
  }
  if (hash === null) {
    throw new Error(`Commit ${JSON.stringify(rev)} not found in ${repoPath}`)
  }
  if (!FULL_SHA_RE.test(hash)) {
    throw new Error(`Unexpected commit hash from ${repoPath}: ${hash}`)
  }
  return hash
}

/**
 * `-c` overrides that blank every filter driver the repository itself defines (`local` and
 * `worktree` scope; `.git/config`, `include.path` files and `config.worktree`). `git status`
 * runs a driver's `clean`/`process` command for each file whose stat data changed and whose
 * attributes (also repository-local: `.git/info/attributes`) name it, so a target that came from
 * an archive or a shared folder could run programs. Drivers from the user's global and system
 * config (for example git-lfs) are theirs and stay. `required=false` keeps a blanked driver that
 * the repository marks as required from failing the whole command.
 *
 * Fails closed: only "no such key" (exit 1) means there is nothing to override; any other failure
 * throws, so `status` never runs with drivers we could not list.
 */
function repoFilterOverrides(repoPath: string): string[] {
  let out: string
  try {
    out = gitRead(
      repoPath,
      [
        'config',
        '-z',
        '--show-scope',
        '--name-only',
        '--get-regexp',
        '^filter\\..+\\.(clean|process)$',
      ],
      { trim: false },
    )
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
  // -z output: scope NUL key NUL, repeated.
  const fields = out.split('\0')
  const names = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i]
    const key = fields[i + 1]!
    if (scope !== 'local' && scope !== 'worktree') continue
    names.add(key.slice('filter.'.length).replace(/\.(clean|process)$/, ''))
  }
  return [...names].flatMap((name) => [
    '-c',
    `filter.${name}.clean=`,
    '-c',
    `filter.${name}.process=`,
    '-c',
    `filter.${name}.required=false`,
  ])
}

/**
 * Paths with uncommitted changes (staged, unstaged or untracked, not ignored) in a working tree.
 * Read-only: `--no-optional-locks` keeps `git status` from refreshing and rewriting the index, and
 * the target's own filter drivers are blanked (see `repoFilterOverrides`). Submodules are only
 * compared by commit (`--ignore-submodules=dirty`): looking inside one starts a `git status` in
 * it, which would run the drivers of the submodule's own config. [] when there is no work tree;
 * any other failure throws, so a clean answer is never a guess.
 */
export function uncommittedChanges(repoPath: string): string[] {
  if (gitRead(repoPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') return []
  const out = gitRead(
    repoPath,
    [
      ...repoFilterOverrides(repoPath),
      'status',
      '--porcelain=v1',
      '-z',
      '--ignore-submodules=dirty',
    ],
    { trim: false },
  )
  const paths: string[] = []
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (rec.length < 4) continue
    paths.push(rec.slice(3))
    // Renames and copies are followed by the original path as a separate record.
    if (rec[0] === 'R' || rec[0] === 'C') i++
  }
  return paths
}

/** Human-readable warning for uncommitted changes in the target, or null if it is clean. */
export function uncommittedWarning(repoPath: string, commit: string): string | null {
  let changes: string[]
  try {
    changes = uncommittedChanges(repoPath)
  } catch (err) {
    const detail = gitErrorDetail(err).split('\n')[0]
    return (
      `Could not check the target repo for uncommitted changes (${detail}); the course is pinned to ` +
      `${commit.slice(0, 12)} whatever the working tree holds.`
    )
  }
  if (changes.length === 0) return null
  // File names come from the target: one physical line per notice, whatever the names contain.
  const shown = changes.slice(0, 5).map(escapeControls).join(', ')
  const more = changes.length > 5 ? ` and ${changes.length - 5} more` : ''
  return (
    `Target repo has ${changes.length} uncommitted change(s) that are not part of the pinned commit ` +
    `${commit.slice(0, 12)}: ${shown}${more}. Commit them and run \`course pin\` if the course should cover them.`
  )
}

/**
 * The target's `origin` URL if it is a network remote, with credentials removed: password, query
 * string (e.g. `?private_token=`) and fragment always; the user name only for http(s), where it
 * is an account or token. ssh:// keeps it (`git@`), as scp-style URLs do: it is the login the
 * host expects, and without it ssh would try the local user name. Local-path remotes return null
 * so that no absolute filesystem path ends up in committed files.
 */
export function readShareableRemote(repoPath: string): string | null {
  let url: string
  try {
    url = gitRead(repoPath, ['remote', 'get-url', 'origin'])
  } catch {
    return null
  }
  if (/^(?:https?|ssh|git):\/\//i.test(url)) {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') u.username = ''
      u.password = ''
      u.search = ''
      u.hash = ''
      return u.toString()
    } catch {
      return null
    }
  }
  // scp-like syntax: git@github.com:owner/repo.git or git@host:/srv/git/app.git (the user part is a
  // login name, not a secret). The user@host: prefix is what tells it from a local path.
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return url
  return null
}

/**
 * True if a remote-tracking branch of `origin` contains `commit` (i.e. it was pushed there):
 * `.gitmodules` records `origin`, so a commit that is only on another remote does not count.
 */
export function isCommitOnRemoteBranch(repoPath: string, commit: string): boolean {
  if (!FULL_SHA_RE.test(commit)) throw new Error(`Not a full commit SHA: ${commit}`)
  try {
    return gitRead(repoPath, ['branch', '-r', '--contains', commit, '--list', 'origin/*']) !== ''
  } catch {
    return false
  }
}

export function initGitRepo(dir: string): void {
  gitWrite(dir, ['init', '-q'])
}

export function addSubmodule(
  courseDir: string,
  targetRepo: string,
  submodulePath: string,
  committedUrl: string,
): void {
  const absTarget = path.resolve(targetRepo)
  // Local paths use the file:// transport; Git 2.38+ blocks it for submodules unless explicitly
  // allowed. The override is scoped to this one command and to the user-chosen local path.
  gitWrite(courseDir, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--',
    absTarget,
    submodulePath,
  ])
  // `submodule add` records the absolute local path in .gitmodules. Replace it with the target's
  // network remote so no /home/<user>/... path is committed. The local .git/config keeps the
  // absolute URL, so this clone continues to work.
  gitWrite(courseDir, [
    'config',
    '-f',
    '.gitmodules',
    `submodule.${submodulePath}.url`,
    committedUrl,
  ])
  gitWrite(courseDir, ['add', '--', '.gitmodules'])
}

/** A fetch over the network can be slow, but must not hang `course pin` forever. */
const FETCH_TIMEOUT_MS = 300_000

/**
 * Fetch a submodule checkout's `origin` (branches and tags, then its HEAD) and return the commit
 * the remote's HEAD points at. In submodule mode the checkout's own HEAD is the current pin, so
 * new target commits are only visible after this. Writes only to the workspace's submodule.
 */
export function fetchSubmoduleOrigin(subDir: string): string {
  for (const args of [
    ['fetch', '--quiet', 'origin'],
    ['fetch', '--quiet', 'origin', 'HEAD'],
  ]) {
    try {
      requireModernGit()
      execFileSync('git', [...GIT_HARDENING_ARGS, '-C', subDir, ...args], {
        stdio: 'pipe',
        timeout: FETCH_TIMEOUT_MS,
        env: childEnv(),
      })
    } catch (err) {
      throw new Error(`Could not fetch origin in ${subDir}: ${gitErrorDetail(err)}`)
    }
  }
  return resolveCommit(subDir, 'FETCH_HEAD')
}

export function checkoutSubmoduleCommit(
  courseDir: string,
  submodulePath: string,
  commit: string,
): void {
  if (!FULL_SHA_RE.test(commit)) throw new Error(`Not a full commit SHA: ${commit}`)
  gitWrite(path.join(courseDir, submodulePath), ['checkout', '-q', '--detach', commit])
  gitWrite(courseDir, ['add', '--', submodulePath])
}
