# course_kit

Turn any code repository into an interactive, narrated browser course (Slidev decks in Polish and English),
authored together with a coding agent. Point `course` at a repo; it creates a separate workspace pinned to a
commit of that target. Runs locally only — no GitHub Pages.

**Status:** early WIP (step 1: scaffold + `course init` only).

## Quickstart

```bash
npm install
npm run build
npm link   # optional: install `course` globally from this clone

course init /path/to/your/repo --out ./my-course --lang pl,en
cd my-course && npm install && npm run dev
```

See `course init --help`. Optional `--submodule` vendors the target repo under `target-repo/`.

## Licensing

| Artifact                                      | License                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Software in this repo (CLI, tooling)          | [MIT](LICENSE)                                                                                                   |
| Lesson text in course workspaces (`lessons/`) | [CC BY 4.0](LICENSE-CONTENT) — each generated workspace ships its own `LICENSE-CONTENT`; fill in year and author |
| Generated audio                               | Not licensed for redistribution — keep under `audio/local/` (gitignored); never commit                           |

## Docs

- [ADR 0001 — stack & repo reference](docs/adr/0001-node-typescript-cli-and-repo-reference.md)
- [AGENTS.md](AGENTS.md) — conventions for coding agents in this repo
