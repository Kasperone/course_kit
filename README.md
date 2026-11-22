# course_kit

Turn any code repository into an interactive, narrated browser course (Slidev decks in Polish and English),
authored together with a coding agent. Point `course` at a repo; it creates a separate workspace pinned to a
commit of that target. Runs locally only — no GitHub Pages.

**Status:** early WIP (step 3: `course pin`, Slidev `course build`/`course dev`, first real lesson in
[`examples/faktura`](examples/faktura/lessons/01-architecture/en/slides.md)).

## Quickstart

```bash
npm install
npm run build
npm link   # optional: install `course` globally from this clone

# 1. Create a workspace pinned to the target's HEAD (warns about uncommitted changes)
course init /path/to/your/repo --out ./my-course --lang en,pl
cd my-course
npm install                          # Slidev for this workspace (no Playwright, no PDF export)

# 2. Add a lesson and build its context pack from the pinned commit
course lesson new 02-invoices        # lesson.json + en/pl slide placeholders
course context 02-invoices --json    # lessons/02-invoices/context-pack.md (+ .json)
# ... write lessons/02-invoices/en/slides.md from the pack (facts only from the pack)

# 3. The target moved on? Re-pin and rebuild the pack
course pin                           # pinnedCommit: <old> -> <new>; or `course pin v1.2` / a SHA
course context 02-invoices

# 4. Preview and build the decks
course dev 02-invoices --lang en     # live preview on localhost
course build                         # dist/<lesson>/<lang>/ + dist/index.html
npx vite preview --outDir dist       # serve dist/ at http://localhost:4173
```

See `course <command> --help`. `pin`, `build` and `dev` accept `-C <workspace>`. Optional
`--submodule` on `init` vendors the target repo under `target-repo/` (the target needs a network `origin`, which
`.gitmodules` records) and `course pin` then fetches that checkout's `origin` (a bare `course pin` takes the
remote's HEAD) and moves the checkout too. The workspace must live outside the target repo; the default `--out` is
`./<repo>-course` in the current directory.

Context packs always read the target repo at the **pinned commit** in `course.json` (see [ADR 0002](docs/adr/0002-context-pack-format.md)).
Edit `lessons/<id>/lesson.json` to choose sources: `files` are exact paths, `globs` are globs (quote them on the
command line: `course context 02-invoices --files 'backend/src/**/*.java'`). Secret files (`.env*`, keys,
credentials) are never embedded and secret-looking values are redacted; the pack's _Selection report_ lists
everything that was skipped. `course.json` stores the target path relative to the workspace; on another machine
set `COURSE_TARGET_REPO=/path/to/clone`.

Decks are Mermaid-only, fully offline and export-free (see [ADR 0003](docs/adr/0003-slidev-build-and-dev.md)):

- every generated deck uses system fonts (no Google Fonts requests) and an empty `data:` favicon (Slidev's
  default is on cdn.jsdelivr.net);
- it points Slidev's PlantUML server at a `data:` URL;
- it turns off Slidev's browser exporter (no `/export` page in `course dev`), its deck-editing MCP server
  (`/__mcp`) and the PDF download.

`course build`/`course dev` refuse to start if a deck's headmatter drops these settings, if a deck contains
PlantUML, if a file references a web-font CDN, if a slide loads a remote resource (images, embeds, scripts,
styles, `<Tweet>`/`<Youtube>`, `url:` iframe layouts, reference-style images; inline plain links are fine), or if a
slide `src:` import or `<<<` snippet leaves the checked files (or reads a context pack or a secret-looking file such as `.env`). `course dev` checks when it starts; `course build` is the gate for
later edits. Slidev runs without your API keys in its environment. The
build fails if its output references plantuml.com, a font CDN or the jsDelivr favicon. `course build` does not
need the target repo.

### Example

[`examples/faktura`](examples/faktura) is a real workspace for the
[faktura](https://github.com/Kasperone/faktura) repo with lesson `01-architecture` (13 slides, sources on every
slide, speaker notes per click):

```bash
npm ci --prefix examples/faktura
node dist/cli.js build -C examples/faktura
```

Building the decks needs nothing else. `course context` and `course pin` for the example read the faktura repo
through the relative path in `examples/faktura/course.json` (`../../../faktura`), so faktura must be cloned
**next to** course_kit:

```bash
cd ..   # the directory that contains course_kit/
git clone https://github.com/Kasperone/faktura.git
cd course_kit/examples/faktura
node ../../dist/cli.js context 01-architecture   # or: COURSE_TARGET_REPO=/path/to/faktura ...
```

## Licensing

| Artifact                                      | License                                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Software in this repo (CLI, tooling)          | [MIT](LICENSE)                                                                                                                                        |
| Lesson text in course workspaces (`lessons/`) | [CC BY 4.0](templates/workspace/LICENSE-CONTENT) — each generated workspace ships its own `LICENSE-CONTENT`; the course author fills in year and name |
| Generated audio                               | Not licensed for redistribution — keep under `audio/local/` (gitignored); never commit                                                                |

## Docs

- [ADR 0001 — stack & repo reference](docs/adr/0001-node-typescript-cli-and-repo-reference.md)
- [ADR 0002 — context-pack format](docs/adr/0002-context-pack-format.md)
- [ADR 0003 — Slidev build and live preview](docs/adr/0003-slidev-build-and-dev.md)
- [AGENTS.md](AGENTS.md) — conventions for coding agents in this repo
