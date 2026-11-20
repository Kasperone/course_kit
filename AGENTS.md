# Agent guide (course_kit repo)

## Purpose

This repository hosts the `course` CLI and templates. Agents scaffold and later generate lesson content;
step 1 only implements `course init`.

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

CLI:

```bash
course --help
course init <path-to-target-repo> [--out <dir>] [--lang pl,en] [--submodule]
```

## Tests

- `tests/init.test.ts` — creates temp git repos, runs `runInit`, asserts `course.json`, Slidev skeleton, lessons, audio tree, PlantUML guard.
- `tests/cli.test.ts` — builds `dist/cli.js` and runs the README quickstart against it.

Always run lint and tests before pushing.

## Conventions

- English for code, docs, and commit messages; conventional commits (`feat:`, `fix:`, `chore:`, …).
- Minimal dependencies; Slidev deps belong in generated workspaces, not necessarily in the root package.
- Follow [ADR 0001](docs/adr/0001-node-typescript-cli-and-repo-reference.md) for stack and repo reference modes.

## Never commit

- `.env` or real API keys (ElevenLabs, etc.)
- Files under `audio/local/` or other generated narration
- Secrets in `course.json` or lesson content

## Generated course workspaces

Templates live in `templates/workspace/`. After changing templates, run tests. Mermaid only: Slidev cannot disable
PlantUML, so every deck sets `plantUmlServer` to a `data:` URL and `scripts/check-no-plantuml.mjs` fails
`dev`/`build`/`export` on any PlantUML block (see ADR 0001).
