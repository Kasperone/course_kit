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
  stays a workspace dependency, never a course_kit dependency. Slidev, its theme and addons and
  the workspace code it loads (`vite.config.*`, `setup/*`) get an allowlisted environment
  (`childEnv()` plus `NODE_*`, `VITE_*`, `SLIDEV_*`, `DEBUG`, `BROWSER`), so an exported API key
  never reaches them. Names that look like a secret are dropped even under those wildcards: a
  known suffix or a whole `_`-separated word (`KEY`, `PASS`, `SECRET`, `TOKEN`, `PRIVATE`, …, so
  `VITE_ELEVENLABS_KEY` and `SLIDEV_SECRET_KEY` do not pass, while `VITE_API_URL` does). Vite
  exposes `VITE_*` to client code, so a secret under that prefix would reach the browser. A build
  that does not finish within 10 minutes is stopped (`course dev` is interactive and has no limit).
- `course dev` checks the deck policy **when the server starts**. Slidev hot-reloads edits, so a
  remote image or embed added during a session renders until the next `course build` (or restart)
  refuses it; the guard is not a live watcher.
- Neither needs the target repo, so a cloned workspace (or CI) builds without it.
- The workspace `npm run dev` / `npm run build` scripts still serve and build the root
  `slides.md`.

### No export, fully offline (deck policy)

No PDF/PNG export and no Playwright or `playwright-chromium` dependency (decided by Kasper,
2026-11-20). The template has no `export` script, and npm does not install Slidev's optional peer
`playwright-chromium`. Decks also make no requests beyond the local server (Kasper, 2026-11-21).
Every generated deck's headmatter therefore pins:

| Key               | Value                                                                          | Why (checked in the Slidev 52.20.1 source)                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plantUmlServer`  | `"data:text/plain,plantuml-disabled"`                                          | see below                                                                                                                                                                                                                |
| `fonts`           | `sans: system-ui`, `serif: ui-serif`, `mono: ui-monospace`, `provider: "none"` | The default provider `google` adds a `fonts.googleapis.com` stylesheet for the theme fonts (Avenir Next, Nunito Sans, Fira Code). With `none`, no web-font link is emitted, and Slidev appends system fallback stacks.   |
| `favicon`         | `"data:,"`                                                                     | The default favicon is `https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png`, linked from every page. An empty data: URL loads nothing (a `public/` path would break under `--base`).                         |
| `browserExporter` | `false`                                                                        | The default `"dev"` registers the `/export` route and the export button in the dev server. `false` removes both.                                                                                                         |
| `mcp`             | `false`                                                                        | The default `true` serves an unauthenticated MCP server at `/__mcp` in the dev server whose tools (`slidev-update-slide`, …) rewrite the deck files; any page on localhost could strip this policy. `false` answers 403. |
| `download`        | `false`                                                                        | `true`/`"auto"` would export a PDF at build time and enable the `/print` route.                                                                                                                                          |

`course build`/`course dev` refuse to start Slidev unless each deck they run has this headmatter.
The check accepts the block form and the flow form (`fonts: { provider: none }`). They also refuse
any workspace Markdown/Vue/CSS/HTML file that references a web-font CDN (`fonts.googleapis.com`,
`fonts.gstatic.com`, `fonts.coollabs.io`). After a build, the output scan fails on those hosts too,
and on `cdn.jsdelivr.net` in an HTML file (the default favicon).

Workspace Markdown/Vue/CSS/HTML must not load remote resources while a slide renders: Markdown
images, `src`/`href`/`poster`/… on loading tags (`img`, `iframe`, `script`, `link`, `video`, `audio`,
`source`, …, also Vue `:src`), CSS `url()`/`@import`, `<Tweet>`/`<Youtube>`, and `image:`/
`background:`/`url:` frontmatter (`url:` feeds Slidev's `iframe` layouts) pointing at another host
(loopback is allowed), reference-style link definitions (`[label]: https://…`, which also flags
reference-style plain links) and Mermaid image nodes (`A@{ img: "https://…" }`). Inline plain links
are fine: they make no request until clicked. Context packs are skipped by every scan (they quote the target
as data: a Google Fonts `<link>` or a pom's `<plantuml.version>` in a pack must not stop a build), and for that
reason no deck may import one. Slide imports must stay inside the scanned files: `src: ./other.md` and Slidev's
code snippets (`<<< ../code.ts`, resolved against the deck's own directory, `@/` included; `<<<` is scanned on
every line, also in fences, block quotes and lists, because Slidev resolves it there too). Refused: absolute paths,
paths outside the workspace, skipped directories (`node_modules/`, `dist/`, `audio/`, `target-repo/`), symlinks,
context packs and secret-looking files (the context-pack denylist: `.env*`, keys, kubeconfigs, …, plus
`course.local.json`), snippets in a PlantUML language (Slidev renders them as a PlantUML request) and Mermaid
snippets that load a remote image. Without this, `<<< ../../../.env text` puts the workspace `.env` into the
built deck (reproduced with Slidev 52.20.1; an e2e test keeps the negative control). So everything Slidev
renders has passed the checks above. This is pattern matching, not a sandbox: a
deck author who wants to load something remote can still find a way; the guard catches mistakes and
the common forms.
The template's `scripts/check-deck.mjs` (formerly `check-no-plantuml.mjs`) applies the same rules to
the root `slides.md` for `npm run dev/build`.

Quirk: Slidev 52's dev-server banner still lists `export slides > …/export/` even with
`browserExporter: false`. The banner tests the JSON-stringified flag (`"false"`, which is truthy),
while the client receives the real `false` through Vite's defines. Opening `/export/` shows the
normal slideshow.

### `course pin`

Git calls on the target (`rev-parse`, `status`, `cat-file`, the submodule `fetch`) pin the same
hardening config as context packs (`GIT_HARDENING_ARGS`: no implicit bare repos, no fsmonitor, no
signature checks), run with an allowlisted environment and a timeout. In submodule mode a branch
name resolves to `refs/remotes/origin/<name>` first (the checkout's local branches are frozen at
clone time and never move on `fetch`), then to the name as given (tags, SHAs, `origin/<name>`).

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
- Favicon: the policy gives `<link rel="icon" href="data:,">`; the default links the jsDelivr
  favicon, and the output scan reports it.
- MCP: with `mcp: false` a JSON-RPC `initialize` to `/__mcp` gets Slidev's "disabled" 403; without
  it, the same call gets the server's `serverInfo`.
- Dev server: with the policy, `/@vite/env` defines `__SLIDEV_FEATURE_BROWSER_EXPORTER__` and
  `__SLIDEV_FEATURE_PRINT__` as `false` and the page has no Google Fonts or jsDelivr link; with the
  defaults, the exporter is `true` and both links are present.

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
