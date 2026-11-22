import { Command } from 'commander'
import { parseInitArgs, runInit } from './commands/init.js'

const program = new Command()

program
  .name('course')
  .description('Create and manage browser courses from code repositories')
  .version('0.1.0')

program
  .command('init')
  .description('Create a new course workspace from a target git repository')
  .argument('<path-to-target-repo>', 'Path to the repository the course explains')
  .option(
    '--out <dir>',
    'Output directory for the course workspace (default: ./<repo>-course in the current directory)',
  )
  .option('--lang <codes>', 'Comma-separated lesson languages', 'pl,en')
  .option(
    '--submodule',
    'Also add the target repo as a git submodule at target-repo/ (the target needs a network origin)',
  )
  .action(async (target: string, opts: { out?: string; lang?: string; submodule?: boolean }) => {
    try {
      const options = parseInitArgs({
        target,
        out: opts.out,
        lang: opts.lang,
        submodule: opts.submodule,
      })
      const { outDir, course, notices } = await runInit(options)
      console.log(`Course workspace created at ${outDir}`)
      console.log(`Pinned commit: ${course.pinnedCommit}`)
      console.log(`Reference mode: ${course.referenceMode}`)
      for (const notice of notices) console.warn(`Note: ${notice}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`course init failed: ${message}`)
      process.exitCode = 1
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
