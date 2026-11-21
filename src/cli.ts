import { Command } from 'commander'
import { runAsk } from './commands/ask.js'
import { runContext } from './commands/context.js'
import { parseInitArgs, runInit } from './commands/init.js'
import { runLessonNew } from './commands/lesson-new.js'
import { runNarrate } from './commands/narrate.js'
import { runVoicesInstall, runVoicesList } from './commands/voices.js'
import { runPin } from './commands/pin.js'
import { describeChat, runServe } from './commands/serve.js'
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
      const { outDir, course, warnings } = await runInit(options)
      for (const warning of warnings) console.error(`warning: ${warning}`)
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
  .option('--no-narration', 'Do not copy narration clips from audio/local/ into dist/')
  .action((opts: { cwd?: string; lesson?: string; lang?: string; narration?: boolean }) => {
    try {
      const result = runBuild({
        cwd: opts.cwd,
        lesson: opts.lesson,
        lang: opts.lang,
        narration: opts.narration !== false,
      })
      for (const deck of result.decks) {
        console.log(`Built ${deck.lessonId}/${deck.lang} -> ${deck.outDir}`)
      }
      for (const n of result.narration) {
        console.log(`Narration ${n.lessonId}/${n.lang}: ${n.clips} clips -> ${n.dir}`)
      }
      console.log(`Index: ${result.index}`)
      console.log(`View: course serve -C ${result.courseDir}  (decks and Q&A chat on 127.0.0.1)`)
    } catch (err) {
      fail('build', err)
    }
  })

const parsePort = (v: string) => Number.parseInt(v, 10)

program
  .command('dev')
  .description(
    'Live preview of one lesson deck (Slidev dev server on localhost) with the Q&A chat backend',
  )
  .argument('<lesson-id>', 'Lesson id (directory under lessons/)')
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .option('--lang <code>', 'Deck language (default: first language in course.json)')
  .option('--port <n>', 'Dev server port', parsePort)
  .option(
    '--provider <id>',
    'Chat provider: anthropic-api (default, API key), claude-cli or cursor-cli (subscription)',
  )
  .option(
    '--model <id>',
    'Chat model for the provider (default: COURSE_CHAT_MODEL, course.json, provider default)',
  )
  .option('--no-chat', 'Do not start the Q&A chat backend')
  .action(
    async (
      lessonId: string,
      opts: {
        cwd?: string
        lang?: string
        port?: number
        model?: string
        provider?: string
        chat?: boolean
      },
    ) => {
      try {
        process.exitCode = await runDev({
          lesson: lessonId,
          lang: opts.lang,
          port: opts.port,
          cwd: opts.cwd,
          model: opts.model,
          provider: opts.provider,
          chat: opts.chat !== false,
        })
      } catch (err) {
        fail('dev', err)
      }
    },
  )

program
  .command('serve')
  .description(
    'Serve the built course (dist/) and the Q&A chat API from one local origin (127.0.0.1 only)',
  )
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .option('--port <n>', 'Port on 127.0.0.1 (default: course.json chat.port, else 8787)', parsePort)
  .option(
    '--provider <id>',
    'Chat provider: anthropic-api (default, API key), claude-cli or cursor-cli (subscription)',
  )
  .option(
    '--model <id>',
    'Chat model for the provider (default: COURSE_CHAT_MODEL, course.json, provider default)',
  )
  .option('--no-chat', 'Serve the decks without the Q&A API')
  .action(
    async (opts: {
      cwd?: string
      port?: number
      model?: string
      provider?: string
      chat?: boolean
    }) => {
      try {
        const server = await runServe({
          cwd: opts.cwd,
          port: opts.port,
          model: opts.model,
          provider: opts.provider,
          chat: opts.chat !== false,
          log: (line) => console.error(line),
        })
        console.log(`Serving ${server.distDir} at ${server.url}/`)
        console.log(describeChat(server.chat))
        console.log('Press Ctrl+C to stop.')
        const stop = () => void server.close().then(() => process.exit(0))
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      } catch (err) {
        fail('serve', err)
      }
    },
  )

program
  .command('ask')
  .description("Ask the lesson's Q&A chat from the terminal (same prompt and model as the deck)")
  .argument('<lesson-id>', 'Lesson id (directory under lessons/)')
  .argument('[question]', 'The question (quote it)')
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .option('--lang <code>', 'Answer language (default: first language in course.json)')
  .option('--slide <n>', 'Slide the question is about (default 1)', parsePort)
  .option(
    '--provider <id>',
    'Chat provider: anthropic-api (default, API key), claude-cli or cursor-cli (subscription)',
  )
  .option(
    '--model <id>',
    'Chat model for the provider (default: COURSE_CHAT_MODEL, course.json, provider default)',
  )
  .option('--dry-run', 'Show prompt sizes and a cost estimate; call no API', false)
  .action(
    async (
      lessonId: string,
      question: string | undefined,
      opts: {
        cwd?: string
        lang?: string
        slide?: number
        model?: string
        provider?: string
        dryRun?: boolean
      },
    ) => {
      // Ctrl+C stops the answer (and kills a CLI provider's process group) before exiting.
      const ac = new AbortController()
      const stop = () => ac.abort()
      process.once('SIGINT', stop)
      try {
        if (!question && !opts.dryRun) throw new Error('Missing question (or use --dry-run)')
        await runAsk({
          lessonId,
          question,
          cwd: opts.cwd,
          lang: opts.lang,
          slide: opts.slide,
          model: opts.model,
          provider: opts.provider,
          dryRun: Boolean(opts.dryRun),
          signal: ac.signal,
        })
      } catch (err) {
        if (ac.signal.aborted) process.exitCode = 130
        else fail('ask', err)
      } finally {
        process.off('SIGINT', stop)
      }
    },
  )

program
  .command('narrate')
  .description(
    'Generate one audio clip per slide/click step from the speaker notes into audio/local/<lang>/<lesson-id>/',
  )
  .argument('<lesson-id>', 'Lesson id (directory under lessons/)')
  .option('-C, --cwd <dir>', 'Course workspace directory (default: current directory)')
  .option('--lang <code>', 'Deck language, or "all"', 'all')
  .option('--provider <id>', 'TTS provider: piper (offline) or elevenlabs (API)', 'piper')
  .option('--voice <id>', 'Voice (Piper voice name or ElevenLabs voice id)')
  .option('--model <id>', 'ElevenLabs model id (default: eleven_multilingual_v2)')
  .option(
    '--audio-quality <preset>',
    'compact (MP3 64k), standard (MP3 128k), high (MP3 192k) or lossless (WAV); default: course.json audioQuality, else standard',
  )
  .option('--force', 'Regenerate clips even when a cached clip exists', false)
  .option('--prune', 'Delete clips from earlier runs that the new manifest does not use', false)
  .option('--dry-run', 'List steps and character counts; synthesize nothing', false)
  .action(
    async (
      lessonId: string,
      opts: {
        cwd?: string
        lang?: string
        provider?: string
        voice?: string
        model?: string
        audioQuality?: string
        force?: boolean
        prune?: boolean
        dryRun?: boolean
      },
    ) => {
      try {
        const result = await runNarrate({
          lessonId,
          cwd: opts.cwd,
          lang: opts.lang,
          provider: opts.provider,
          voice: opts.voice,
          model: opts.model,
          audioQuality: opts.audioQuality,
          force: Boolean(opts.force),
          prune: Boolean(opts.prune),
          dryRun: Boolean(opts.dryRun),
          log: (m) => console.log(m),
          warn: (m) => console.error(`warning: ${m}`),
        })
        if (opts.dryRun) return
        console.log(`Audio quality: ${result.quality}`)
        for (const r of result.langs) {
          console.log(
            `${r.lang}: ${r.clips} clips (${r.generated} generated, ${r.reused} cached), ${r.totalDuration.toFixed(1)} s -> ${r.manifest}`,
          )
          if (r.stale.length > 0) {
            console.log(
              `  ${r.stale.length} older clips are not in the manifest (--prune removes them)`,
            )
          }
          if (r.pruned.length > 0) console.log(`  removed ${r.pruned.length} older clips`)
        }
      } catch (err) {
        fail('narrate', err)
      }
    },
  )

const voices = program.command('voices').description('Manage local TTS voices (Piper)')

voices
  .command('install')
  .description('Download a pinned Piper voice (sha256-verified) into the user voice cache')
  .argument('<engine>', 'Voice engine (piper)')
  .argument('<voice>', 'Voice name, e.g. pl_PL-darkman-medium')
  .action(async (engine: string, voice: string) => {
    try {
      const r = await runVoicesInstall({ engine, voice })
      console.log(`Voice ${r.voice.name} -> ${r.dir}`)
      if (r.downloaded.length > 0) console.log(`Downloaded: ${r.downloaded.join(', ')}`)
      if (r.verified.length > 0)
        console.log(`Already present (sha256 ok): ${r.verified.join(', ')}`)
      console.log(`Dataset: ${r.voice.dataset} (${r.voice.datasetLicense}); ${r.voice.training}`)
    } catch (err) {
      fail('voices install', err)
    }
  })

voices
  .command('list')
  .description('List installable Piper voices, their licences and install state')
  .action(() => {
    const r = runVoicesList()
    console.log(`Voice dir: ${r.dir}`)
    console.log(`Piper: ${r.piper}`)
    console.log(`rhasspy/piper-voices @ ${r.revision}`)
    for (const v of r.voices) {
      console.log(
        `  ${v.installed ? '[x]' : '[ ]'} ${v.name} (${v.lang}) — dataset ${v.dataset}, ${v.license}`,
      )
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
