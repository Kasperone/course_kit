import { Command } from 'commander'
import { runContext } from './commands/context.js'
import { parseInitArgs, runInit } from './commands/init.js'
import { runLessonNew } from './commands/lesson-new.js'
import { packageVersion } from './lib/paths.js'

const program = new Command()

program
  .name('course')
  .description('Create and manage browser courses from code repositories')
  .version(packageVersion())

program
  .command('init')
  .description('Create a new course workspace from a target git repository')
  .argument('<path-to-target-repo>', 'Path to the repository the course explains')
  .option('--out <dir>', 'Output directory for the course workspace')
  .option('--lang <codes>', 'Comma-separated lesson languages (default: pl,en)', 'pl,en')
  .option(
    '--submodule',
    'Also add the target repo as a git submodule at target-repo/ (default: pinned path only)',
    false,
  )
  .action(async (target: string, opts: { out?: string; lang?: string; submodule?: boolean }) => {
    try {
      const options = parseInitArgs({
        target,
        out: opts.out,
        lang: opts.lang,
        submodule: opts.submodule,
      })
      const { outDir, course } = await runInit(options)
      console.log(`Course workspace created at ${outDir}`)
      console.log(`Pinned commit: ${course.pinnedCommit}`)
      console.log(`Reference mode: ${course.referenceMode}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`course init failed: ${message}`)
      process.exitCode = 1
    }
  })

const lesson = program.command('lesson').description('Manage lessons in the current workspace')

lesson
  .command('new')
  .description('Create a lesson folder with lesson.json and placeholder slides')
  .argument('<lesson-id>', 'Lesson identifier (e.g. 02-invoices)')
  .action((lessonId: string) => {
    try {
      const { lessonRoot } = runLessonNew({ lessonId })
      console.log(`Lesson created at ${lessonRoot}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`course lesson new failed: ${message}`)
      process.exitCode = 1
    }
  })

program
  .command('context')
  .description('Build a context pack for a lesson from the pinned target commit')
  .argument('<lesson-id>', 'Lesson id (directory under lessons/)')
  .option(
    '--files <glob...>',
    'Additional globs matched against the target repo (quote them; put <lesson-id> first)',
  )
  .option('--out <file>', 'Output Markdown path (default: lessons/<id>/context-pack.md)')
  .option('--json', 'Also write lessons/<id>/context-pack.json metadata', false)
  .action(async (lessonId: string, opts: { files?: string[]; out?: string; json?: boolean }) => {
    try {
      const meta = await runContext({
        lessonId,
        files: opts.files ?? [],
        out: opts.out,
        json: Boolean(opts.json),
      })
      for (const warning of meta.warnings) console.error(`warning: ${warning}`)
      console.log(`Wrote context pack for ${lessonId}`)
      console.log(
        `Files: ${meta.selectedFiles.length}, ~${meta.tokenEstimate} tokens, analyzers: ${
          meta.analyzers.join(', ') || 'none'
        }`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`course context failed: ${message}`)
      process.exitCode = 1
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
