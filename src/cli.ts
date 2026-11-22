import { Command } from 'commander'
import { runContext } from './commands/context.js'
import { parseInitArgs, runInit } from './commands/init.js'
import { terminalSafe } from './lib/terminal.js'
import { runLessonNew } from './commands/lesson-new.js'
import { runPin } from './commands/pin.js'
import { runBuild, runDev } from './commands/slidev.js'
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
      const { outDir, course, warnings } = await runInit(options)
      for (const warning of warnings) console.error(terminalSafe(`warning: ${warning}`))
      console.log(terminalSafe(`Course workspace created at ${outDir}`))
      console.log(`Pinned commit: ${course.pinnedCommit}`)
      console.log(`Reference mode: ${course.referenceMode}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(terminalSafe(`course init failed: ${message}`))
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
      console.log(terminalSafe(`Lesson created at ${lessonRoot}`))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(terminalSafe(`course lesson new failed: ${message}`))
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
      for (const warning of meta.warnings) console.error(terminalSafe(`warning: ${warning}`))
      console.log(`Wrote context pack for ${lessonId}`)
      console.log(
        `Files: ${meta.selectedFiles.length}, ~${meta.tokenEstimate} tokens, analyzers: ${
          meta.analyzers.join(', ') || 'none'
        }`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(terminalSafe(`course context failed: ${message}`))
      process.exitCode = 1
    }
  })

function fail(command: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`course ${command} failed: ${message}`)
  process.exitCode = 1
}

program
  .command('pin')
  .description("Pin the course to a commit of the target repo (default: the target's HEAD)")
  .argument('[commit]', 'Revision to pin: branch, tag, short or full SHA (default: HEAD)')
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .action((commit: string | undefined, opts: { cwd?: string }) => {
    try {
      const result = runPin({ commit, cwd: opts.cwd })
      for (const warning of result.warnings) console.error(`warning: ${warning}`)
      console.log(
        result.changed
          ? `pinnedCommit: ${result.previous} -> ${result.pinned}`
          : `pinnedCommit: ${result.pinned} (unchanged)`,
      )
    } catch (err) {
      fail('pin', err)
    }
  })

program
  .command('build')
  .description('Static Slidev build of lesson decks into dist/<lesson-id>/<lang>/')
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .option('--lesson <id>', 'Build only this lesson')
  .option('--lang <code>', 'Build only this language')
  .action((opts: { cwd?: string; lesson?: string; lang?: string }) => {
    try {
      const result = runBuild({ cwd: opts.cwd, lesson: opts.lesson, lang: opts.lang })
      for (const deck of result.decks) {
        console.log(`Built ${deck.lessonId}/${deck.lang} -> ${deck.outDir}`)
      }
      console.log(`Index: ${result.index}`)
      console.log(`Preview: cd ${result.courseDir} && npx vite preview --outDir dist`)
    } catch (err) {
      fail('build', err)
    }
  })

program
  .command('dev')
  .description('Live preview of one lesson deck (Slidev dev server on localhost)')
  .argument('<lesson-id>', 'Lesson id (directory under lessons/)')
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .option('--lang <code>', 'Deck language (default: first language in course.json)')
  .option('--port <n>', 'Dev server port', (v) => (/^\d+$/.test(v) ? Number(v) : Number.NaN))
  .action(async (lessonId: string, opts: { cwd?: string; lang?: string; port?: number }) => {
    try {
      process.exitCode = await runDev({
        lesson: lessonId,
        lang: opts.lang,
        port: opts.port,
        cwd: opts.cwd,
      })
    } catch (err) {
      fail('dev', err)
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
