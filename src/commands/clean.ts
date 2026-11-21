import {
  applyCursorClean,
  countEntries,
  planCursorClean,
  type CursorCleanPlan,
} from '../lib/chat/cursor-workspace.js'

export type CleanOptions = {
  /** List what would be removed; remove nothing. */
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

export type CleanResult = { plan: CursorCleanPlan; removed: string[] }

/**
 * `course clean`: remove the Cursor agent's transcript folder for the cursor-cli provider's stable
 * workspace (`~/.cursor/projects/<slug>`). Nothing else is touched: other Cursor projects, the
 * workspace itself and Claude Code's files stay. A folder that is a symlink, resolves outside
 * `~/.cursor/projects` or names another workspace is skipped.
 */
export function runClean(options: CleanOptions = {}): CleanResult {
  const log = options.log ?? ((l: string) => console.log(l))
  const plan = planCursorClean(options.env)
  log(`Cursor workspace (kept, empty): ${plan.workspace}`)
  if (plan.targets.length === 0) {
    log(`No Cursor transcripts to remove in ${plan.projectsDir}.`)
    return { plan, removed: [] }
  }
  for (const t of plan.targets) {
    if (t.skipped) log(`Skipping ${t.dir}: ${t.skipped}`)
    else {
      const n = countEntries(t.dir)
      log(
        `${options.dryRun ? 'Would remove' : 'Removing'} ${t.dir} (${n} ${n === 1 ? 'entry' : 'entries'})`,
      )
    }
  }
  if (options.dryRun) return { plan, removed: [] }
  const removed = applyCursorClean(plan)
  log(removed.length ? `Removed ${removed.length} folder(s).` : 'Nothing removed.')
  return { plan, removed }
}
