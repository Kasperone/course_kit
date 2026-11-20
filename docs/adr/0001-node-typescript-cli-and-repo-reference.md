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
- **CLI parsing:** `commander` (only production dependency)
- **Tests:** Vitest; **lint:** ESLint 9 flat config; **format:** Prettier
- **Generated workspace:** standard Slidev project (`@slidev/cli`), Mermaid diagrams only

Rationale: aligns with Slidev, avoids a second runtime (Python/Rust) for step 1, and keeps the
published CLI lean while pushing Slidev weight into the per-course `package.json`.

### Target repository reference

Two modes:

| Mode                      | Flag          | Behaviour                                                                                                                                                            |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pinned path** (default) | _(none)_      | `course.json` stores `targetRepo` as a path **relative to the workspace** and `pinnedCommit` from `git rev-parse HEAD` at init time. No submodule.                   |
| **Submodule**             | `--submodule` | Inits a git repo in the workspace, runs `git submodule add <target> target-repo/`, checks out `pinnedCommit`, then rewrites the `.gitmodules` URL to a portable one. |

No committed file contains a machine-specific absolute path: `course.json` also records
`targetRemote` (the target's network `origin` URL with credentials stripped, or `null`), and
`.gitmodules` uses `targetRemote` when available, otherwise the relative path. When every relative
path would still reveal the local layout (only `/` in common, or a target inside `$HOME` reached
from outside it, e.g. `../../home/<user>/repo`), `targetRepo` is `null` and the absolute path is
written to the gitignored `course.local.json` instead. Resolution order: `COURSE_TARGET_REPO`,
then `course.local.json`, then `course.json`.

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
   if any Markdown file in the workspace contains a PlantUML fence.

Re-check both when upgrading Slidev.

## Consequences

- Contributors need Node 20+; CI uses the same.
- `course init --submodule` requires git; for **local** target paths, Git 2.38+ needs `protocol.file.allow=always` — the CLI passes that flag automatically.
- Future steps can add plugins without changing this ADR's core stack choice.
