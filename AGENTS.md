# Agent guide (course_kit repo)

## Purpose

This repository hosts the `course` CLI and templates. Step 2 adds per-lesson **context packs** for drafting
lesson scripts (Slidev generation remains a later step).

## Commands

```bash
npm install
npm run build          # dist/cli.js + bin
npm run dev -- --help  # run CLI via tsx without building
npm test               # vitest
npm run lint
npm run format:check
npm run typecheck
```

CLI (run from a **course workspace** for context/lesson commands):

```bash
course init <path-to-target-repo> [--out <dir>] [--lang pl,en] [--submodule]
course lesson new <lesson-id>
course context <lesson-id> [--files <glob...>] [--out <file>] [--json]
```

## Tests

- `tests/init.test.ts` — workspace scaffold, input validation, gitignore, portable paths, submodule mode, PlantUML guard.
- `tests/cli.test.ts` — builds `dist/cli.js` and runs the README quickstart against it; checks `npm pack` contents.
- `tests/context.test.ts` — pinned-commit packs, Unicode paths, literal files, caps report, fence safety, Java/jdeps.
- `tests/config.test.ts` — lesson id / course.json / lesson.json validation, submodule mode, `COURSE_TARGET_REPO`.
- `tests/secrets.test.ts` — denylist and redaction against a hostile fixture repo.
- `tests/fs-safe.test.ts` — no workspace write follows a symlink.
- `tests/child-env.test.ts` — `childEnv()` allowlist; git and jdeps run without API keys (wrapper scripts on PATH);
  the git >= 2.38 check.

Always run lint and tests before pushing.

## Conventions

- English for code, docs, and commit messages; conventional commits (`feat:`, `fix:`, `chore:`, …).
- Minimal dependencies; Slidev deps belong in generated workspaces, not necessarily in the root package.
- Follow ADR [0001](docs/adr/0001-node-typescript-cli-and-repo-reference.md) and [0002](docs/adr/0002-context-pack-format.md).

## Never commit

- `.env` or real API keys (ElevenLabs, etc.)
- Files under `audio/local/` or other generated narration
- Secrets in `course.json` or lesson content
- Generated context packs: gitignored in workspaces; force-add one only after reviewing it (secrets are
  denylisted and redacted, but that is a safety net)

## Child processes and git

- Every child process gets `childEnv()` from `src/lib/child-env.ts` (an allowlist, plus `GIT_TERMINAL_PROMPT=0`),
  never `process.env`: an exported API key must not reach git or anything it runs. Extend the allowlist only
  for names a tool needs to run.
- Git calls on a target repository go through `gitRead` in `src/lib/git.ts`: `GIT_HARDENING_ARGS`
  (`safe.bareRepository=explicit`, no fsmonitor, no signature checks), `--no-optional-locks`, a timeout, and a
  once-per-process check for git >= 2.38 (older git ignores `safe.bareRepository`). Reuse these constants
  for any new git call on a target.
- `--submodule` needs a network `origin` on the target (a relative `.gitmodules` URL resolves against the
  course's own remote); never fall back to a relative path.

## Generated course workspaces

Templates live in `templates/workspace/`. Lessons use `lessons/<id>/lesson.json` plus per-language `slides.md`.
Context packs are written next to the lesson. Mermaid only: Slidev cannot disable PlantUML, so every deck
sets `plantUmlServer` to a `data:` URL and `scripts/check-no-plantuml.mjs` fails `dev`/`build`/`export` on any
PlantUML block (see ADR 0001).

## Context packs

Build with `course context <id>`. Packs read the target repo through `src/lib/git-commit.ts` only (`ls-tree -z`,
`cat-file --batch`, full SHAs after `--end-of-options`, `safe.bareRepository=explicit` and no signature checks) —
never the working tree, never `git show`/shell. A `targetRepo` inside the workspace is refused. Validate
any new config field in `src/lib/validate.ts`/`workspace.ts`/`lesson.ts`. New embedded content must go through
`redactSecrets` and `fence()` (or `inlineCode()`, which escapes control characters). Anything the CLI prints that
quotes repository or lesson content goes through `terminalSafe()` (`src/lib/terminal.ts`), and each such fragment is
escaped where it enters the message (`escapeControls()`, or `JSON.stringify()` for a rejected value): `terminalSafe`
keeps line breaks for git's multi-line errors, so a newline in a file name would otherwise forge a line. Extend `src/analyzers/` for
language-specific graphs.
