# ADR 0003: Slidev build and live preview (no export)

## Status

Accepted (step 3)

## Context

Lessons are Slidev decks at `lessons/<id>/<lang>/slides.md` in a course workspace. Step 3 needs a
way to preview them while writing and to build them into static pages, with the same "no diagram
source leaves the machine" guarantee as ADR 0001, and a first real lesson (faktura
`01-architecture`) that proves the chain end to end.

## Decision

### Commands

- `course build [-C dir] [--lesson <id>] [--lang <code>]`: one `slidev build` per deck into
  `dist/<id>/<lang>/` with `--base /<id>/<lang>/` and `--router-mode hash`, then
  `dist/index.html` linking every deck present in `dist/`. Serve `dist/` from its root (e.g.
  `npx vite preview --outDir dist`); hash routing means no server-side fallback is needed.
- `course dev <id> [--lang] [--port] [-C dir]`: `slidev <entry>` dev server for one deck
  (localhost only; default language is the first in `course.json`).
- Both run the **workspace's own** Slidev (`node_modules/@slidev/cli`, `bin` from its
  `package.json`) with `process.execPath`: no shell, no global install, no `.cmd` shims. Slidev
  stays a workspace dependency, never a course_kit dependency.
- Neither needs the target repo, so a cloned workspace (or CI) builds without it.
- The workspace `npm run dev` / `npm run build` scripts still serve and build the root
  `slides.md`.

### No export

No PDF/PNG export and no Playwright or `playwright-chromium` dependency (decided by Kasper,
2026-11-20). The template has no `export` script. Slidev's optional peer `playwright-chromium`
is not installed by npm. Do not set `download: true` in a deck: Slidev would try to export a PDF
at build time.

### Slidev version

The template pins `@slidev/cli` **52.20.1** and `@slidev/theme-default` **0.25.0** exactly. 53.x
requires Node >= 22.22, while course_kit supports Node 20; 52.x is the newest line that supports
Node 20 (>= 20.12). Workspaces commit their `package-lock.json`.

### PlantUML at render time

Slidev 52.20.1 behaves like 51.8.2 (ADR 0001): a `plantuml` fence becomes
`<PlantUml server=…>` → `<img src="${server}/svg/<encoded source>">`, with the default server
`https://www.plantuml.com/plantuml`. Three layers:

1. **Before Slidev starts** (`course build`/`course dev`, and the template's
   `check-no-plantuml.mjs` for `npm run dev/build`): fail on any ` ```plantuml `/`~~~plantuml`
   fence or `<PlantUml>`/`<plant-uml>` component in workspace Markdown or Vue files. Symlinks are
   not followed; `node_modules`, `dist`, `.git`, `target-repo` and `audio` are skipped.
2. **Headmatter:** every deck sets `plantUmlServer: "data:text/plain,plantuml-disabled"`.
3. **After the build:** `course build` fails if any built HTML/JS/CSS/JSON file mentions
   `plantuml.com`.

Verified live: `tests/slidev-e2e.test.ts` builds a deck with a PlantUML block (bypassing layer 1)
and finds no `plantuml.com` in the output, and the same deck without the headmatter does contain it
(negative control, so layer 3 is shown to detect the default). A headless-browser network log of
the probe deck and of all faktura slides showed no PlantUML request; the PlantUML `<img>` points at
the `data:` URL. The CI `deck` job runs the e2e test on Node 20 and 22.

### Diagrams

Mermaid only, via Slidev's built-in client-side renderer (checked in a headless browser). D2 is
not added: it needs an extra binary or plugin. The Java analyzer's own-package graph is drawn
`LR` with packages grouped in a subgraph: in a Slidev render, `TB` stacks unconnected packages
into a column that overflows the slide.

### Example workspace

`examples/faktura` is a committed course workspace (pinned faktura commit, lesson
`01-architecture`, lockfile) so the PR can be reviewed and CI can build a real deck. Context packs
stay gitignored. Prettier and ESLint skip `examples/`.

## Consequences

- Upgrading Slidev means re-running the e2e test, re-checking `PlantUml.vue` and the code-block
  transformer, and keeping the Node floor in mind.
- The default theme loads web fonts from Google Fonts when a deck is viewed (seen in the network
  log). This is a privacy/offline concern separate from PlantUML. A deck can opt out with
  `fonts: { provider: none }`; this is still open.
- PDF/PNG handouts need a new decision (and a browser dependency) if they are ever wanted.
