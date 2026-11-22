# ADR 0001: Node/TypeScript CLI and target repo reference

## Status

Accepted (step 1)

## Context

`course_kit` scaffolds Slidev-based course workspaces. Slidev and its ecosystem are Node-first.
We need a small CLI (`course init`) that works cross-platform, ships as a dev tool, and keeps
dependencies minimal for the tool itself (generated workspaces carry their own Slidev deps).

## Decision

### Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript (ESM), built with `tsup` to a single `course` bin
- **CLI parsing:** `commander`; `minimatch` for lesson globs (step 2, BlueOak-1.0.0, a permissive
  MIT-compatible licence). These are the only production dependencies.
- **Tests:** Vitest; **lint:** ESLint 9 flat config; **format:** Prettier
- **Generated workspace:** standard Slidev project (`@slidev/cli`), Mermaid diagrams only

Rationale: aligns with Slidev, avoids a second runtime (Python/Rust) for step 1, and keeps the
published CLI lean while pushing Slidev weight into the per-course `package.json`.

### Target repository reference

Two modes:

| Mode                      | Flag          | Behaviour                                                                                                                                                                           |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pinned path** (default) | _(none)_      | `course.json` stores `targetRepo` as a path **relative to the workspace** and `pinnedCommit` from `git rev-parse HEAD` at init time. No submodule.                                  |
| **Submodule**             | `--submodule` | Inits a git repo in the workspace, runs `git submodule add <target> target-repo/`, checks out `pinnedCommit`, then rewrites the `.gitmodules` URL to the target's network `origin`. |

No committed file contains a machine-specific absolute path: `course.json` also records
`targetRemote` (the target's network `origin` URL without password, query string or fragment, and
without the user name for http(s); ssh keeps its `git@` login, or `null`), and
`.gitmodules` uses `targetRemote`. `--submodule` therefore **requires** a network `origin` on the
target and fails otherwise: a relative `.gitmodules` URL is resolved by git against the _course's_
`origin`, not the workspace directory, so it breaks every collaborator's clone (or fetches from an
unrelated host) unless the target happens to be hosted next to the course under the same name.
When every relative path would still reveal the local layout (only `/` in common, or a target inside `$HOME` reached
from outside it, e.g. `../../home/<user>/repo`), `targetRepo` is `null` and the absolute path is
written to the gitignored `course.local.json` instead, and `course init` says so. The relative path
is computed between physical paths (`realpath` of the workspace, git's top level of the target) and
resolved against the workspace's physical directory, and a symlinked `$HOME` counts under both its
names, so symlinks can neither leak `/home/<user>` nor make the path point elsewhere. Resolution
order: `COURSE_TARGET_REPO`, then `course.local.json`, then `course.json`. With `--submodule` and a
network URL, `course init` warns if no `origin` remote-tracking branch contains the pinned commit
(others could not clone it), and it warns when the target has uncommitted changes (the course is
pinned to HEAD). The workspace must be a separate directory: `course init` refuses an `--out`
inside the target repository (the default is `./<repo>-course` in the current directory, so
`course init .` from inside the repo needs `--out ../<repo>-course`).

Default is **pinned path only**: cheapest, no nested git setup, sufficient for local courses where
the target repo path is stable. Submodule is optional for teams that want the target tree vendored
inside the course repo.

### Diagrams

Mermaid only. Slidev (checked against 51.8.2) has no switch to turn PlantUML off: it always turns
` ```plantuml ` blocks into `<img src="${plantUmlServer}/svg/<encoded source>">`, and
`plantUmlServer` defaults to `https://www.plantuml.com/plantuml`. Slidev does not read a
`slidev.config.ts` file. The workspace therefore uses two layers:

1. **Headmatter:** every generated deck (`slides.md` and each lesson `slides.md`) sets
   `plantUmlServer: 'data:text/plain,plantuml-disabled'`, so a stray PlantUML block becomes a
   local no-op instead of a network request.
2. **Guard:** `scripts/check-no-plantuml.mjs` runs as `predev`, `prebuild` and `preexport` and fails
   if any Markdown file in the workspace contains a PlantUML fence. It never follows symlinks.

Re-check both when upgrading Slidev.

### Offline

Decks make no third-party requests when opened. Besides PlantUML, Slidev has two online defaults
(checked against 51.8.2 and 52.20.1): its font provider is Google Fonts (`theme: default` asks for
Nunito Sans and Fira Code) and its favicon is `https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png`.
Every generated deck's headmatter therefore also sets:

- `fonts:` system stacks (`system-ui`, `ui-serif`, `ui-monospace`) with `provider: 'none'`, so no
  font `<link>` is emitted;
- `favicon: 'data:,'`, an empty data: URL, so no icon is fetched. A `public/` file would not do:
  lesson decks have their own root, and `slidev build --base` would break an absolute path.

The workspace pins `@slidev/cli` to `^51.8.2`, the version these defaults were checked against.

## Consequences

- Contributors need Node 20+; CI uses the same.
- `course init --submodule` requires git; for **local** target paths, Git 2.38+ needs `protocol.file.allow=always` — the CLI passes that flag automatically.
- course_kit needs git >= 2.38 and checks `git --version` before its first call: every read of a target repository pins `safe.bareRepository=explicit`, `core.fsmonitor=false` and `log.showSignature=false` on the command line (`GIT_HARDENING_ARGS`), and older git silently ignores the first.
- Child processes get an allowlisted environment (`src/lib/child-env.ts`, `childEnv()`): `PATH`, `HOME`, locale, temp dir, terminal, proxy and ssh-agent variables plus `GIT_TERMINAL_PROMPT=0`. An exported API key never reaches git or anything git runs (hooks, credential helpers).
- Future steps can add plugins without changing this ADR's core stack choice.
