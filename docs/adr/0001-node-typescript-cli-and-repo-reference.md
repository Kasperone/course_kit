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

| Mode                      | Flag          | Behaviour                                                                                                                                                      |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pinned path** (default) | _(none)_      | `course.json` stores absolute `targetRepo` path and `pinnedCommit` from `git rev-parse HEAD` at init time. No submodule.                                       |
| **Submodule**             | `--submodule` | Inits a git repo in the workspace, runs `git submodule add <target> target-repo/`, checks out `pinnedCommit`. `course.json` sets `referenceMode: "submodule"`. |

Default is **pinned path only**: cheapest, no nested git setup, sufficient for local courses where
the target repo path is stable. Submodule is optional for teams that want the target tree vendored
inside the course repo.

### Diagrams

PlantUML is **disabled** in generated `slidev.config.ts` (`plantuml: false`). Lesson templates use
Mermaid only, avoiding Slidev's default behaviour of sending PlantUML source to plantuml.com.

## Consequences

- Contributors need Node 20+; CI uses the same.
- `course init --submodule` requires git; for **local** target paths, Git 2.38+ needs `protocol.file.allow=always` — the CLI passes that flag automatically.
- Future steps can add plugins without changing this ADR's core stack choice.
