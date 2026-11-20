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

### No export, fully offline (deck policy)

No PDF/PNG export and no Playwright or `playwright-chromium` dependency (decided by Kasper,
2026-11-20). The template has no `export` script, and npm does not install Slidev's optional peer
`playwright-chromium`. Decks also make no requests beyond the local server (Kasper, 2026-11-21).
Every generated deck's headmatter therefore pins:

| Key               | Value                                                                          | Why (checked in the Slidev 52.20.1 source)                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plantUmlServer`  | `"data:text/plain,plantuml-disabled"`                                          | see below                                                                                                                                                                                                              |
| `fonts`           | `sans: system-ui`, `serif: ui-serif`, `mono: ui-monospace`, `provider: "none"` | The default provider `google` adds a `fonts.googleapis.com` stylesheet for the theme fonts (Avenir Next, Nunito Sans, Fira Code). With `none`, no web-font link is emitted, and Slidev appends system fallback stacks. |
| `browserExporter` | `false`                                                                        | The default `"dev"` registers the `/export` route and the export button in the dev server. `false` removes both.                                                                                                       |
| `download`        | `false`                                                                        | `true`/`"auto"` would export a PDF at build time and enable the `/print` route.                                                                                                                                        |

`course build`/`course dev` refuse to start Slidev unless each deck they run has this headmatter.
The check accepts the block form and the flow form (`fonts: { provider: none }`). They also refuse
any workspace Markdown/Vue/CSS/HTML file that references a web-font CDN (`fonts.googleapis.com`,
`fonts.gstatic.com`, `fonts.coollabs.io`). After a build, the output scan fails on those hosts too.
The template's `scripts/check-deck.mjs` (formerly `check-no-plantuml.mjs`) applies the same rules to
the root `slides.md` for `npm run dev/build`.

Quirk: Slidev 52's dev-server banner still lists `export slides > …/export/` even with
`browserExporter: false`. The banner tests the JSON-stringified flag (`"false"`, which is truthy),
while the client receives the real `false` through Vite's defines. Opening `/export/` shows the
normal slideshow.

### Slidev version

The template pins `@slidev/cli` **52.20.1** and `@slidev/theme-default` **0.25.0** exactly. 53.x
requires Node >= 22.22, while course_kit supports Node 20; 52.x is the newest line that supports
Node 20 (>= 20.12). Workspaces commit their `package-lock.json`.

### PlantUML at render time

Slidev 52.20.1 behaves like 51.8.2 (ADR 0001): a `plantuml` fence becomes
`<PlantUml server=…>` → `<img src="${server}/svg/<encoded source>">`, with the default server
`https://www.plantuml.com/plantuml`. Three layers:

1. **Before Slidev starts** (`course build`/`course dev`, and the template's
   `check-deck.mjs` for `npm run dev/build`): fail on any ` ```plantuml `/`~~~plantuml`
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

The e2e test covers the rest of the deck policy the same way, each with a negative control:

- Fonts: the policy headmatter gives a build with no web-font host; Slidev's default gives
  `fonts.googleapis.com`.
- Dev server: with the policy, `/@vite/env` defines `__SLIDEV_FEATURE_BROWSER_EXPORTER__` and
  `__SLIDEV_FEATURE_PRINT__` as `false` and the page has no Google Fonts link; with the defaults,
  the exporter is `true` and the link is present.

Locally, a headless-browser network log of all 13 faktura slides (build) and of `/export/` (dev)
showed only localhost requests.

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
- Decks use system fonts, so they look slightly different per OS.
- PDF/PNG handouts need a new decision (and a browser dependency) if they are ever wanted.
