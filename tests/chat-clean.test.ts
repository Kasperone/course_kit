import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runClean } from '../src/commands/clean.js'
import {
  cursorProjectSlug,
  cursorProjectsDir,
  cursorWorkspaceDir,
  planCursorClean,
} from '../src/lib/chat/cursor-workspace.js'
import { makeTempDir } from './helpers/tmp.js'

/** A private HOME with Cursor's projects dir; our workspace folder and an unrelated one. */
function setup() {
  const home = makeTempDir('clean-home')
  const env: NodeJS.ProcessEnv = { HOME: home }
  const workspace = cursorWorkspaceDir(env)
  const projects = cursorProjectsDir(env)
  mkdirSync(projects, { recursive: true })
  const ours = path.join(projects, cursorProjectSlug(workspace))
  const other = path.join(projects, 'home-someone-Documents-projects-app')
  for (const d of [ours, other]) {
    mkdirSync(path.join(d, 'agent-transcripts', 'abc'), { recursive: true })
    writeFileSync(path.join(d, 'agent-transcripts', 'abc', 't.jsonl'), '{}\n')
    writeFileSync(path.join(d, 'repo.json'), '{}')
  }
  writeFileSync(
    path.join(ours, '.workspace-trusted'),
    JSON.stringify({ trustedAt: 'x', workspacePath: workspace }),
  )
  return { home, env, workspace, projects, ours, other }
}

const run = (env: NodeJS.ProcessEnv, dryRun = false) => {
  const lines: string[] = []
  const result = runClean({ env, dryRun, log: (l) => lines.push(l) })
  return { ...result, lines }
}

describe('cursor workspace paths', () => {
  it('the workspace follows XDG_CACHE_HOME, then ~/.cache; the slug is the path like Cursor names it', () => {
    expect(cursorWorkspaceDir({ HOME: '/home/u' })).toBe('/home/u/.cache/course-kit/cursor-ws')
    expect(cursorWorkspaceDir({ HOME: '/home/u', XDG_CACHE_HOME: '/var/c' })).toBe(
      '/var/c/course-kit/cursor-ws',
    )
    // A relative XDG_CACHE_HOME is ignored (the spec says so).
    expect(cursorWorkspaceDir({ HOME: '/home/u', XDG_CACHE_HOME: 'rel' })).toBe(
      '/home/u/.cache/course-kit/cursor-ws',
    )
    expect(cursorProjectSlug('/home/u/.cache/course-kit/cursor-ws')).toBe(
      'home-u-cache-course-kit-cursor-ws',
    )
    expect(cursorProjectSlug('/home/u/Documents/projects/course_kit')).toBe(
      'home-u-Documents-projects-course-kit',
    )
  })
})

describe('course clean', () => {
  it('--dry-run lists the folder and removes nothing', () => {
    const t = setup()
    const r = run(t.env, true)
    expect(r.removed).toEqual([])
    expect(r.lines.join('\n')).toContain(`Would remove ${t.ours} (`)
    expect(r.lines.join('\n')).not.toContain(t.other)
    expect(existsSync(t.ours)).toBe(true)
    expect(existsSync(t.other)).toBe(true)
  })

  it('removes only the folder of the stable workspace', () => {
    const t = setup()
    const r = run(t.env)
    expect(r.removed).toEqual([t.ours])
    expect(existsSync(t.ours)).toBe(false)
    expect(readdirSync(t.projects)).toEqual(['home-someone-Documents-projects-app'])
    expect(existsSync(path.join(t.other, 'agent-transcripts', 'abc', 't.jsonl'))).toBe(true)
    // Idempotent.
    const again = run(t.env)
    expect(again.removed).toEqual([])
    expect(again.lines.join('\n')).toMatch(/No Cursor transcripts to remove/)
  })

  it('leaves the workspace directory itself alone', () => {
    const t = setup()
    mkdirSync(t.workspace, { recursive: true })
    run(t.env)
    expect(existsSync(t.workspace)).toBe(true)
  })

  it('does nothing when Cursor has no projects directory', () => {
    const env = { HOME: makeTempDir('clean-empty') }
    const r = run(env)
    expect(r.removed).toEqual([])
    expect(r.plan.targets).toEqual([])
  })

  it('refuses a symlinked folder: removing it must never delete the target', () => {
    const t = setup()
    const victim = makeTempDir('clean-victim')
    writeFileSync(path.join(victim, 'keep.txt'), 'keep')
    rmSync(t.ours, { recursive: true })
    symlinkSync(victim, t.ours)
    const r = run(t.env)
    expect(r.removed).toEqual([])
    expect(r.lines.join('\n')).toMatch(/Skipping .*not a directory/)
    expect(existsSync(path.join(victim, 'keep.txt'))).toBe(true)
  })

  it('refuses a folder whose .workspace-trusted names another workspace', () => {
    const t = setup()
    writeFileSync(
      path.join(t.ours, '.workspace-trusted'),
      JSON.stringify({ workspacePath: '/home/someone/Documents/projects/app' }),
    )
    const r = run(t.env)
    expect(r.removed).toEqual([])
    expect(r.lines.join('\n')).toMatch(/belongs to another workspace/)
    expect(existsSync(t.ours)).toBe(true)
  })

  it('a symlinked projects directory never leads outside it', () => {
    const home = makeTempDir('clean-home')
    const env = { HOME: home }
    const real = makeTempDir('clean-real-projects')
    mkdirSync(path.join(home, '.cursor'))
    symlinkSync(real, path.join(home, '.cursor', 'projects'))
    // The folder of our slug is a real directory inside the (user's own) symlinked projects dir:
    // that is fine; a slug that resolves elsewhere is not.
    const slugDir = path.join(real, cursorProjectSlug(cursorWorkspaceDir(env)))
    const outside = makeTempDir('clean-outside')
    symlinkSync(outside, slugDir)
    const plan = planCursorClean(env)
    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0]!.skipped).toBeDefined()
    expect(run(env).removed).toEqual([])
    expect(existsSync(outside)).toBe(true)
  })
})
