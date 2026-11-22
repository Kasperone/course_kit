import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPlainObject } from '../validate.js'

/**
 * The Cursor agent keeps a transcript folder per workspace in `~/.cursor/projects/<slug>/`, so a fresh
 * temp workspace per question would leave one folder behind each time. The cursor-cli provider therefore
 * uses ONE stable, empty workspace (ADR 0005, "Providers"); `course clean` removes the matching folder.
 */

const home = (env: NodeJS.ProcessEnv): string => env.HOME || os.homedir()

/**
 * `$XDG_CACHE_HOME/course-kit/cursor-ws` (default `~/.cache/course-kit/cursor-ws`). Holds nothing
 * but our own deny-all `.cursor/cli.json` (see `CURSOR_DENY_ALL_CONFIG`).
 */
export function cursorWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME
  const cache = xdg && path.isAbsolute(xdg) ? xdg : path.join(home(env), '.cache')
  return path.join(cache, 'course-kit', 'cursor-ws')
}

/** Cursor's per-workspace state: `~/.cursor/projects`. */
export function cursorProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), '.cursor', 'projects')
}

/**
 * Cursor names a workspace's folder after its absolute path: no leading slash, every run of other
 * characters becomes one `-` (`/home/u/.cache/x_y` -> `home-u-cache-x-y`).
 */
export function cursorProjectSlug(workspace: string): string {
  return workspace.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Project-level permissions for the Cursor agent (`.cursor/cli.json`, merged over the user's own
 * config; deny rules win): no shell, no file reads or writes, no web fetches, no MCP tools. Cursor's
 * `--mode ask` is read-only but still agentic (file read/search, possibly web and MCP tools), and
 * the prompt carries untrusted repository text, so the tools are denied as well. The patterns are
 * the agent's own grammar (`Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`,
 * `Mcp(server:tool)`; verified against cursor-agent 2026.11.19).
 */
export const CURSOR_DENY_ALL_CONFIG = {
  permissions: {
    allow: [] as string[],
    deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)', 'Mcp(*:*)'],
  },
}

const CURSOR_CONFIG_TEXT = `${JSON.stringify(CURSOR_DENY_ALL_CONFIG, null, 2)}\n`

/**
 * Create the stable workspace if missing (0700), check that it is what we expect and return it. It
 * must be a real directory of the current user, not a symlink, so `--trust` can only ever cover this
 * one directory. `--trust` also makes Cursor load project config and rules from the workspace, so
 * it must hold nothing but our deny-all `.cursor/cli.json`: any other entry (a stray file, a
 * `.cursor/mcp.json`, rules or hooks) makes the provider unavailable instead of being trusted.
 */
export function ensureCursorWorkspace(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory()) {
    throw new Error(`${dir} must be a real directory (not a symlink or file)`)
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user`)
  }
  const refuse = (what: string): never => {
    throw new Error(
      `${dir} must hold nothing but .cursor/cli.json (found ${JSON.stringify(what).slice(0, 80)}). ` +
        "Remove the extra entry, or the whole directory (`course clean` removes Cursor's folder for it).",
    )
  }
  for (const e of readdirSync(dir)) if (e !== '.cursor') refuse(e)
  const cursorDir = path.join(dir, '.cursor')
  try {
    const cst = lstatSync(cursorDir)
    if (!cst.isDirectory()) refuse('.cursor')
    for (const e of readdirSync(cursorDir)) if (e !== 'cli.json') refuse(`.cursor/${e}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    mkdirSync(cursorDir, { mode: 0o700 })
  }
  const config = path.join(cursorDir, 'cli.json')
  let current: string | null = null
  try {
    if (!lstatSync(config).isFile()) refuse('.cursor/cli.json')
    current = readFileSync(config, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // Rewritten when missing or changed (a leftover permissive file is ours to replace).
  if (current !== CURSOR_CONFIG_TEXT) writeFileSync(config, CURSOR_CONFIG_TEXT, { mode: 0o600 })
  return dir
}

export type CursorCleanTarget = {
  /** The Cursor folder to remove (inside ~/.cursor/projects). */
  dir: string
  /** Why it was left alone, when it is not removed. */
  skipped?: string
}

export type CursorCleanPlan = {
  workspace: string
  projectsDir: string
  targets: CursorCleanTarget[]
}

/** True if `child` is strictly inside `parent` (both resolved). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Which Cursor folders belong to the stable workspace: only `~/.cursor/projects/<slug>` for its
 * path. A folder is refused when it is a symlink, resolves outside `~/.cursor/projects`, or its
 * `.workspace-trusted` names another workspace. Nothing is removed here.
 */
export function planCursorClean(env: NodeJS.ProcessEnv = process.env): CursorCleanPlan {
  const workspace = cursorWorkspaceDir(env)
  const projectsDir = cursorProjectsDir(env)
  const plan: CursorCleanPlan = { workspace, projectsDir, targets: [] }
  const slug = cursorProjectSlug(workspace)
  if (!slug) return plan
  const dir = path.join(projectsDir, slug)
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return plan // nothing there
  }
  if (!st.isDirectory()) {
    plan.targets.push({ dir, skipped: 'not a directory (symlink or file)' })
    return plan
  }
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    plan.targets.push({ dir, skipped: 'cannot be resolved' })
    return plan
  }
  if (!isInside(realpathSync(projectsDir), real)) {
    plan.targets.push({ dir, skipped: `resolves outside ${projectsDir}` })
    return plan
  }
  const named = trustedWorkspace(dir)
  if (named !== null && named !== workspace) {
    plan.targets.push({ dir, skipped: `belongs to another workspace (${named})` })
    return plan
  }
  plan.targets.push({ dir })
  return plan
}

/** The workspace path Cursor recorded in `.workspace-trusted`, or null when absent or unreadable. */
function trustedWorkspace(projectDir: string): string | null {
  try {
    const j: unknown = JSON.parse(readFileSync(path.join(projectDir, '.workspace-trusted'), 'utf8'))
    return isPlainObject(j) && typeof j.workspacePath === 'string' ? j.workspacePath : null
  } catch {
    return null
  }
}

/** Number of entries (files and directories, recursively) in a folder, for the report. */
export function countEntries(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += 1
    if (e.isDirectory()) n += countEntries(path.join(dir, e.name))
  }
  return n
}

/** Remove the planned folders (the skipped ones stay); returns the removed paths. */
export function applyCursorClean(plan: CursorCleanPlan): string[] {
  const removed: string[] = []
  for (const t of plan.targets) {
    if (t.skipped) continue
    rmSync(t.dir, { recursive: true, force: true })
    removed.push(t.dir)
  }
  return removed
}
