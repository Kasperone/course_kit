# ADR 0002: Context pack format and pinned-commit reads

## Status

Accepted (step 2)

## Context

Agents need a single artifact per lesson to draft Slidev scripts and (later) ground Q&A.
The target repository may drift on disk; packs must be reproducible from the course workspace’s
`course.json` `pinnedCommit`.

## Decision

### Command

- `course context <lesson-id>` runs **inside a course workspace** (requires `course.json`).
- Config from `lessons/<id>/lesson.json` (`files`, `globs`, `focus`, `notes`) plus optional CLI `--files`.
- Default output: `lessons/<id>/context-pack.md`; `--json` also writes `context-pack.json` metadata.

### Pinned-commit I/O

All target-repo content is read via git object database, never the working tree:

- File list: `git ls-tree -r --name-only <pinnedCommit>`
- Contents: `git show <pinnedCommit>:<path>`
- History: `git log <pinnedCommit> -n N -- <paths>`

### Pack sections (Markdown)

1. Header table (lesson, repo, commit, timestamp)
2. Focus / notes from `lesson.json`
3. Repository tree summary (tracked paths, binaries skipped, caps on listing)
4. Excerpts from `README.md`, `AGENTS.md`, `CLAUDE.md` if present
5. Selected sources with **line numbers** (size/line caps)
6. Related tests (name/path heuristics)
7. Recent git log for selected paths
8. Language-specific analysis (plugin hook)
9. Size / token estimate

Metadata JSON (`schemaVersion: 1`) records selected files, analyzers used, byte size, token estimate.

### Analyzers

TypeScript interface in `src/analyzers/`; registry picks analyzers by `detect()`.
Step 2 ships **Java only**:

- Prefer `jdeps` on `.jar`/`.class` blobs materialized from the pinned commit when `jdeps` is on PATH.
- Otherwise **package-import graph** from `.java` sources → Mermaid `flowchart`.

### Lesson layout

```
lessons/<lesson-id>/
  lesson.json
  pl/slides.md
  en/slides.md
  context-pack.md   # generated
  context-pack.json # optional
```

`course lesson new <id>` creates `lesson.json` and placeholder slides per `course.json` `languages`.

## Consequences

- Re-run `course context` after changing `lesson.json` or pinning a new commit (future `course pin`).
- Large repos rely on globs and limits in `PACK_LIMITS`; tune in code when real courses hit caps.
- Additional languages add analyzers without changing the Markdown skeleton.
