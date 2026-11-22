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
- Config from `lessons/<id>/lesson.json` plus optional CLI `--files` globs:
  - `files`: exact repo-relative paths (no glob syntax, so `app/[id]/page.tsx` works);
  - `globs`: minimatch globs, dotfiles included (default: `README.md`, `src/**`, `lib/**`,
    `backend/**`, `frontend/**`);
  - `focus`, `notes`: free text copied into the pack;
  - `limits`: optional overrides of `PACK_LIMITS` (e.g. `{ "maxSelectedFiles": 80 }`).
- Default output: `lessons/<id>/context-pack.md`; `--json` also writes `context-pack.json`
  (next to `--out` when given). Generated packs are gitignored in the workspace.

### Input validation

`course.json` and `lesson.json` are schema-checked on every read: `pinnedCommit` must be a full SHA,
languages and lesson ids are single safe path segments, patterns are repo-relative without `..`,
and lesson paths must stay inside `lessons/`. Errors name the file and field.

### Pinned-commit I/O

All target-repo content is read via the git object database, never the working tree. The
repository is `COURSE_TARGET_REPO` if set, the checked-out submodule in submodule mode, otherwise
`course.local.json` or `course.json` `targetRepo` resolved against the workspace. Those two files
come with a shared workspace, so a target they name must lie outside the workspace: otherwise a
cloned workspace could commit a bare repository's files and make them the target. The check
compares paths and also walks up from the target's real path looking for the workspace's device
and inode, so a case-insensitive filesystem (`../MY-COURSE/evil` for a workspace `my-course/`)
cannot make the two spellings differ.

Every call pins, on the command line (which overrides repository config), the settings that could
make git run a program: `safe.bareRepository=explicit` (no implicit bare repos),
`log.showSignature=false` (no `gpg.program`) and `core.fsmonitor=false`
(`GIT_HARDENING_ARGS`, shared with `course init`). `safe.bareRepository` exists since git 2.38 and
older git silently ignores it, so course_kit refuses to run on older git. Pack reads never touch
the network either: in a partial clone (`--filter=blob:none`) git would otherwise run `git fetch`
against the target's own remote config to fill in a missing blob, so they set `GIT_NO_LAZY_FETCH=1`
(git 2.44+) and `protocol.allow=never` (older versions) and fail with "partial clone: fetch the
missing files or point `COURSE_TARGET_REPO` at a full clone". Calls time out after
120 s, `jdeps` after 60 s. git and `jdeps` run with an allowlisted environment (`childEnv()`; for
jdeps also `JAVA_HOME`), so an exported API key never reaches them. `course lesson new` reads only `course.json`, so it works in a fresh
clone without the target.

- Commit check: `git cat-file -e --end-of-options <sha>^{commit}` (clear error if it is gone)
- File list and sizes: one `git ls-tree -r -z -l --full-tree --end-of-options <sha>`
- Contents: one `git cat-file --batch` for all embedded blobs (by object id)
- History: `git --literal-pathspecs log -n N --end-of-options <sha> -- <paths>`. A failure of this
  call (timeout, a path list too long for the command line) is reported as a warning and in the
  History section, never as "No log entries".

NUL-separated output keeps non-ASCII and unusual paths intact. Symlinks are never followed (the
blob is the link text) and are skipped, as are gitlinks; both are listed in the selection report,
including related tests. A selected file that turns out to be binary by content is reported as
skipped and not counted or listed as embedded.

### Sensitive data

Packs go to LLMs and may be shared, so:

1. A path **denylist** (`src/lib/context-pack/sensitive.ts`) always wins, even over explicit
   `files`: `.env*` (except `.env.example`/`sample`/`template`), SSH keys, `*.pem`/`*.key`/`*.ppk`/keystores,
   credentials files (including kubeconfigs), `secrets/`, Terraform state/vars, service-account keys, and Spring
   `application-{prod,production,local,secret}*` profiles.
2. Everything embedded passes through line-preserving **redaction** (`redact.ts`): known token
   formats (including `sk_…` keys), JWTs, `Bearer <token>` (the prefix stays, `Bearer ${TOKEN}`
   templates do not match), private key blocks, URL passwords, literal assignments
   to secret-looking names, unquoted `NAME=value` assignments to upper-snake secret-looking names in
   any file (`export DB_PASSWORD=…`, `ENV API_TOKEN=…`; values of 4+ characters, however short; `$VAR`
   references, plain numbers and booleans stay), and
   secret-looking keys in config files (`${VAR:default}` keeps `VAR`, hides the default).
   That includes the git log (author names and subjects), reported as `(git log)`.

Both are listed in the pack, the JSON and as CLI warnings. This is a safety net, not a secret
scanner; review packs before committing them.

### Pack sections (Markdown)

1. Header table (lesson, workspace-relative repo path, remote, commit, timestamp) and a note that
   quoted content is data, not instructions
2. Focus / notes from `lesson.json`
3. Selection report: matched / embedded counts, every skipped path with its reason (sensitive,
   over-cap, too-large, binary, symlink, submodule), redactions, missing `files`, empty globs
4. Repository tree summary (tracked paths, binaries skipped, caps on listing)
5. Excerpts from `README.md`, `AGENTS.md`, `CLAUDE.md` if present (not repeated when selected),
   line-numbered like sources
6. Selected sources and related tests with **line numbers** (size/line caps)
7. Related tests (name/path heuristics, own cap)
8. Recent git log for selected paths
9. Language-specific analysis (plugin hook)
10. Size / token estimate

Embedded content uses fences longer than any backtick run inside it, so repository text cannot
close a fence or add headings to the pack. Paths and log lines are inline code with every control
character escaped (`\r`, `\n`, `\xNN`): CommonMark also ends a line at a lone `\r`. Line numbers
(`     N|`) keep embedded Markdown off column 0, so a target's PlantUML block does not trip the
workspace guard.

Metadata JSON (`schemaVersion: 1`) records limits, selected files, related tests, skipped paths
with reasons, redactions, analyzers used, warnings, byte size and token estimate.

### Analyzers

TypeScript interface in `src/analyzers/`; registry picks analyzers by `detect()`. Analyzers get
the embedded (redacted) text of selected files plus any matched `.jar`/`.class` blobs as
artifacts (at most 5, 20 MB each). Step 2 ships **Java only**:

- `jdeps -summary` on the artifacts when `jdeps -version` works (graph of artifact → module).
  jdeps is probed before any artifact is read, and temp files are named `<index><extension>`, never
  after the repository's file names.
- Otherwise a **package-import graph** from `.java` sources (wildcard, static and nested-class
  imports map to packages) → Mermaid `flowchart` with generated node ids and quoted labels.
  Since step 3 the graph is limited to the repository's **own packages** (those declared by the
  selected sources; test sources are left out when main sources exist). External imports are
  collapsed into groups such as `org.springframework` and listed under the graph, and packages
  sharing a common prefix are drawn in one subgraph with short labels.

Compiled classes are rarely committed; pointing jdeps at a local build of the pinned commit is a
later step.

### Terminal output

Warnings and errors quote repository content (file names, globs, git output), and the target can be
any third-party repo. The CLI prints them through `terminalSafe()` (`src/lib/terminal.ts`): line
breaks stay, every other control character (ESC, C1 controls, bidirectional overrides) becomes a
visible escape such as `\x1b`. `terminalSafe()` cannot tell a git error's line breaks from one inside a
file name, so every repository- or lesson-derived fragment is escaped where it enters a message
(`escapeControls()` for paths and globs, `JSON.stringify()` for rejected values): a name with a newline
cannot start a forged line (`Files: 99 …`). `context-pack.json` keeps the raw names (JSON escapes them itself).

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

- Re-run `course context` after changing `lesson.json` or pinning a new commit with `course pin`.
- Large repos rely on globs and `limits` in `lesson.json`; caps are reported, never silent.
- Additional languages add analyzers without changing the Markdown skeleton.
