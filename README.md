# course_kit

Turn any code repository into an interactive, narrated browser course (Slidev decks in Polish and English),
authored together with a coding agent. Point `course` at a repo; it creates a separate workspace pinned to a
commit of that target. Runs locally only — no GitHub Pages.

**Status:** early WIP (step 2: context packs + `course lesson new`).

## Quickstart

```bash
npm install
npm run build
npm link   # optional: install `course` globally from this clone

course init /path/to/your/repo --out ./my-course --lang pl,en
cd my-course
course lesson new 02-invoices    # lesson.json + pl/en slide placeholders
course context 02-invoices --json   # context-pack.md (+ .json) from pinned commit
npm install && npm run dev       # Slidev (step 3 will wire lessons)
```

See `course init --help`, `course context --help`. Optional `--submodule` vendors the target repo under `target-repo/` (the target needs a network `origin`, which `.gitmodules` records). The workspace must live outside the target repo; the default `--out` is `./<repo>-course` in the current directory.

Context packs always read the target repo at the **pinned commit** in `course.json` (see [ADR 0002](docs/adr/0002-context-pack-format.md)).
Edit `lessons/<id>/lesson.json` to choose sources: `files` are exact paths, `globs` are globs (quote them on the
command line: `course context 02-invoices --files 'backend/src/**/*.java'`). Secret files (`.env*`, keys,
credentials) are never embedded and secret-looking values are redacted; the pack's _Selection report_ lists
everything that was skipped. `course.json` stores the target path relative to the workspace; on another machine
set `COURSE_TARGET_REPO=/path/to/clone`.

## Licensing

| Artifact                                      | License                                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Software in this repo (CLI, tooling)          | [MIT](LICENSE)                                                                                                                                        |
| Lesson text in course workspaces (`lessons/`) | [CC BY 4.0](templates/workspace/LICENSE-CONTENT) — each generated workspace ships its own `LICENSE-CONTENT`; the course author fills in year and name |
| Generated audio                               | Not licensed for redistribution — keep under `audio/local/` (gitignored); never commit                                                                |

## Docs

- [ADR 0001 — stack & repo reference](docs/adr/0001-node-typescript-cli-and-repo-reference.md)
- [AGENTS.md](AGENTS.md) — conventions for coding agents in this repo
