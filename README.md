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

See `course init --help`, `course context --help`. Optional `--submodule` vendors the target repo under `target-repo/`.

Context packs always read the target repo at the **pinned commit** in `course.json` (see [ADR 0002](docs/adr/0002-context-pack-format.md)).

## Licensing

| Artifact                             | License                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Software in this repo (CLI, tooling) | [MIT](LICENSE)                                                                         |
| Lesson slide text under `lessons/`   | [CC BY 4.0](LICENSE-CONTENT)                                                           |
| Generated audio                      | Not licensed for redistribution — keep under `audio/local/` (gitignored); never commit |

## Docs

- [ADR 0001 — stack & repo reference](docs/adr/0001-node-typescript-cli-and-repo-reference.md)
- [AGENTS.md](AGENTS.md) — conventions for coding agents in this repo
