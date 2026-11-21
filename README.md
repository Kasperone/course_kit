# course_kit

Turn any code repository into an interactive, narrated browser course (Slidev decks in Polish and English),
authored together with a coding agent. Point `course` at a repo; it creates a separate workspace pinned to a
commit of that target. Runs locally only — no GitHub Pages.

**Status:** early WIP (step 5: a Q&A chat panel next to every lesson deck, answered by Claude through a
local backend on 127.0.0.1 and grounded in the lesson's context pack and slides; step 4 added narration
with `course narrate` and the Polish version of the first real lesson in
[`examples/faktura`](examples/faktura/lessons/01-architecture/pl/slides.md)).

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
course dev 02-invoices --lang en     # live preview on localhost, with the Q&A chat
course build                         # dist/<lesson>/<lang>/ + dist/index.html
course serve                         # decks + Q&A chat at http://127.0.0.1:8787/

# 5. Narrate: one clip per slide/click step of the speaker notes (see "Narration")
course narrate 02-invoices --lang all          # Piper, offline; audio/local/<lang>/02-invoices/
course build                                   # copies the clips next to the decks

# 6. Q&A chat (see "Q&A chat"): put ANTHROPIC_API_KEY in .env, then course serve / course dev
#    (or answer with your Claude Code / Cursor subscription: --provider claude-cli | cursor-cli)
course ask 02-invoices --dry-run               # prompt size and cost estimate, no key needed
```

See `course <command> --help`. `pin`, `build`, `dev`, `serve`, `ask` and `narrate` accept `-C <workspace>`. Optional
`--submodule` on `init` vendors the target repo under `target-repo/`; `course pin` then moves that
checkout too.

Context packs always read the target repo at the **pinned commit** in `course.json` (see [ADR 0002](docs/adr/0002-context-pack-format.md)).
Edit `lessons/<id>/lesson.json` to choose sources: `files` are exact paths, `globs` are globs (quote them on the
command line: `course context 02-invoices --files 'backend/src/**/*.java'`). Secret files (`.env*`, keys,
credentials) are never embedded and secret-looking values are redacted; the pack's _Selection report_ lists
everything that was skipped. `course.json` stores the target path relative to the workspace; on another machine
set `COURSE_TARGET_REPO=/path/to/clone`.

Decks are Mermaid-only, fully offline and export-free (see [ADR 0003](docs/adr/0003-slidev-build-and-dev.md)):

- every generated deck uses system fonts (no Google Fonts requests);
- it points Slidev's PlantUML server at a `data:` URL;
- it turns off Slidev's browser exporter (no `/export` page in `course dev`) and the PDF download.

`course build`/`course dev` refuse to start if a deck's headmatter drops these settings, if a deck contains
PlantUML, or if a file references a web-font CDN. The build fails if its output references plantuml.com, a
font CDN, a provider API host or one of the workspace's API keys. `course build` does not need the target repo.

## Narration

Speaker notes (the last HTML comment of a slide) are the narration script; each Slidev `[click]`
marker starts a new step. `course narrate` turns every (slide, click) step into one audio clip in
`audio/local/<lang>/<lesson>/` (gitignored) plus a `manifest.json`, and reuses clips whose text,
provider, voice, model and settings are unchanged (sha256 cache key). See
[ADR 0004](docs/adr/0004-narration-tts-adapters.md).

**Piper (default, offline, free).** Piper is GPL-3.0 and is **not** bundled with course_kit; install
it yourself in a user venv and course_kit runs it as a separate program:

```bash
python3 -m venv ~/.local/share/course_kit/piper-venv
~/.local/share/course_kit/piper-venv/bin/pip install 'piper-tts==1.8.0'   # OHF-Voice/piper1-gpl
course voices install piper pl_PL-darkman-medium    # pinned + sha256-checked, into ~/.cache/course_kit
course voices install piper en_US-ljspeech-medium
course voices list
course narrate 01-architecture --lang all            # --dry-run first to see steps and characters
```

- Voices are downloaded only by `course voices install`, never by `narrate`. Both default voices
  were trained on CC0 / public-domain data, so the generated audio may be redistributed (see
  `audio/ATTRIBUTION.md`).
- `PIPER_BIN` and `COURSE_KIT_VOICES_DIR` override the binary and voice directory. MP3 presets need
  `ffmpeg` on `PATH` (or `FFMPEG_BIN`); without it, clips are written as WAV with a warning.

**Audio quality.** `--audio-quality <preset>`, or `"audioQuality": "<preset>"` in `course.json` for the
whole course (the flag wins; default `standard`). The preset is part of the cache key, so switching
presets regenerates the clips. Sizes were measured on the faktura lesson `01-architecture` with Piper
(EN + PL, 114 clips, about 23.5 minutes of speech):

| Preset               | Output                                                                     | Size, EN + PL | Per minute |
| -------------------- | -------------------------------------------------------------------------- | ------------- | ---------- |
| `compact`            | MP3 64 kbit/s                                                              | 11.3 MB       | ~0.5 MB    |
| `standard` (default) | MP3 128 kbit/s                                                             | 22.6 MB       | ~1 MB      |
| `high`               | MP3 192 kbit/s; with Piper's 22.05 kHz voices, MP3's maximum of 160 kbit/s | 28.3 MB       | ~1.2 MB    |
| `lossless`           | WAV, the TTS output as is, not re-encoded                                  | 62.0 MB       | ~2.6 MB    |

The sample rate and channels are never changed: no upsampling, resampling or downmixing. Piper voices
are 22.05 kHz mono, and MP3 at that rate stops at 160 kbit/s, so `high` uses 160 and says so. `course
build` copies the clips into `dist/`, so a build is about this size per lesson.

**ElevenLabs (optional, paid).** Put `ELEVENLABS_API_KEY=…` in the workspace's `.env` (gitignored)
or the environment; the key is never printed or written anywhere:

```bash
course narrate 01-architecture --lang pl --provider elevenlabs --voice <voice-id> [--model eleven_multilingual_v2]
```

Its audio also stays in `audio/local/`; check your plan's terms before sharing a build. Presets map
to ElevenLabs output formats as delivered (44.1 kHz, no re-encoding): `mp3_44100_64`,
`mp3_44100_128`, `mp3_44100_192` (Creator tier or above) and `wav_44100` (Pro tier or above).

**Generated audio is never committed.** `course narrate` refuses to run if `audio/local/` is not
gitignored or already has tracked files. `--force` regenerates, `--prune` deletes clips that the
new manifest no longer uses.

**Player.** Every lesson deck gets a small control at the top right (the workspace's
`addons/narration` Slidev addon): narration on/off, _auto_ (go to the next step when a clip ends)
and the narration language (EN/PL decks share their click structure, so either language fits
either deck). Nothing plays until you turn it on; a missing clip shows a dimmed "no clip". It
works in `course dev` and in `course build` output (`--no-narration` skips copying the clips), and
it only loads files from the same origin.

## Q&A chat

Every lesson deck has an **Ask** button (the workspace's `addons/chat` Slidev addon). It opens a side
panel where the learner asks about the lesson; answers stream in, in the deck's language. See
[ADR 0005](docs/adr/0005-local-qa-backend-and-chat.md).

```bash
cp .env.example .env && chmod 600 .env   # then fill in ANTHROPIC_API_KEY=… (never committed)
course context 01-architecture           # the chat needs the lesson's context pack
course build && course serve             # http://127.0.0.1:8787/ (or: course dev 01-architecture)
course ask 01-architecture "Why is the session cookie HttpOnly?" --lang pl   # same answers in the terminal
```

- **Grounded, no RAG.** Each question sends the lesson's whole context pack plus the deck's slides
  and speaker notes (one cached prompt prefix, ~23k tokens for faktura lesson 01), the slide the
  learner is on, the question and the last few turns. Answers cite `path:line` and "slide N"; a
  slide reference in the panel jumps to that slide.
- **Sources are marked.** Questions about the lesson's subject (the repo, Java, Spring, security,
  architecture, tooling) are answered; any part not backed by the lesson materials is shown under
  **Not from this lesson**. Unrelated questions get a short redirect.
- **Local backend only.** `course serve` (built decks) and `course dev` (live preview) run the
  backend inside course_kit, bound to `127.0.0.1`. The deck only calls the same-origin path
  `/@course-chat/v1/`; it never sees a key and never calls a provider. The backend accepts only
  loopback `Host` headers and requests from the page's own origin, caps request sizes, and allows 6
  questions a minute, 200 a day and one at a time. Logs hold timings and token counts, never
  questions, answers or keys.
- **Without a key** (or offline, or without a context pack) the panel says what is missing and
  the deck keeps working. Opening `dist/` with any other static server shows "run `course serve`".
- **Privacy.** Questions and the lesson materials (including the code quoted in the pack) go to
  Anthropic (or, with `cursor-cli`, to Cursor and its model provider). Secrets were already
  denylisted and redacted when the pack was built.

**Model and settings.** The default model is `claude-sonnet-5-5` at effort `low`. Choose another with
`--model` (on `serve`, `dev` and `ask`), the `COURSE_CHAT_MODEL` environment variable, or
`course.json`; the flag wins, then the variable, then `course.json`:

```json
"chat": {
  "model": "claude-opus-5-5",
  "effort": "low",
  "maxOutputTokens": 8000,
  "maxPackTokens": 60000,
  "historyTurns": 6,
  "cacheTtl": "5m",
  "refusalFallback": true,
  "rateLimit": { "perMinute": 6, "perDay": 200, "concurrent": 1 },
  "port": 8787,
  "enabled": true
}
```

Estimated cost per question for faktura lesson 01 (from `course ask --dry-run`, ~1k output tokens;
"cached" means within 5 minutes of the previous question):

| Model                         | First question | Cached  |
| ----------------------------- | -------------- | ------- |
| `claude-sonnet-5-5` (default) | ~$0.07         | ~$0.015 |
| `claude-opus-5-5`             | ~$0.14         | ~$0.025 |
| `claude-haiku-5-5`            | ~$0.004        | ~$0.001 |

`refusalFallback` lets the API retry a declined answer on another model (Opus/Sonnet 5.5 only).

### Providers: API key or CLI subscription

The chat can answer through three providers. The Anthropic API stays the default.

| Provider                  | Needs                                                                         | Billing      | Default model           |
| ------------------------- | ----------------------------------------------------------------------------- | ------------ | ----------------------- |
| `anthropic-api` (default) | `ANTHROPIC_API_KEY` in the environment or `.env`                              | per token    | `claude-sonnet-5-5`     |
| `claude-cli`              | [Claude Code](https://claude.com/claude-code) logged in (`claude auth login`) | subscription | `sonnet`                |
| `cursor-cli`              | Cursor agent CLI logged in (`cursor-agent login`)                             | subscription | `claude-sonnet-5-5-low` |

```bash
course serve --provider claude-cli                 # or: COURSE_CHAT_PROVIDER=claude-cli course serve
course ask 01-architecture "Why HttpOnly?" --provider cursor-cli --model claude-opus-5-5-medium
course ask 01-architecture --provider claude-cli --dry-run   # prompt size + "Provider status: ready"
```

Choose the provider like the model: `--provider` (on `serve`, `dev` and `ask`) wins over
`COURSE_CHAT_PROVIDER`, which wins over `chat.provider` in `course.json`. `--model` and
`COURSE_CHAT_MODEL` set the model of the selected provider; in `course.json`, `chat.model` is the API
model and each CLI has its own block (`timeoutSeconds` 10–900, default 180):

```json
"chat": {
  "provider": "claude-cli",
  "claudeCli": { "model": "sonnet", "timeoutSeconds": 180 },
  "cursorCli": { "model": "claude-sonnet-5-5-low" }
}
```

Claude Code takes aliases (`sonnet`, `opus`, `haiku`) or full model names. Cursor model ids include
the effort and depend on your account: list them with `cursor-agent models`. `CLAUDE_BIN` and
`CURSOR_AGENT_BIN` (absolute paths) override the PATH lookup.

How the CLI providers run, and what that costs you:

- **No tools, no permissions.** The CLI is started directly (no shell) in an empty private temp
  directory, never in the repo or the workspace. Claude Code runs with no tools, no MCP servers,
  `--permission-mode dontAsk`, `--restricted`, `--safe-mode` and no session saved; Cursor runs in
  read-only `--mode ask` with its sandbox on. Permission-skipping flags (`--dangerously-skip-permissions`,
  `--force`, `--yolo`) are never used.
- **The prompt goes through stdin** (Claude Code: our instructions and the lesson materials through a
  0600 file in that temp directory, which is deleted afterwards), never through the command line.
- **Limits.** Each answer has a timeout (default 180 s) and an 8 MB output cap; then the CLI and
  anything it started are killed. `ANTHROPIC_*` and `ELEVENLABS_*` variables are removed from the
  CLI's environment, so it always uses its own login.
- **Slower and uncached.** The API provider reuses the cached ~23k-token prefix; a CLI provider
  sends the whole prompt every time (whatever caching the CLI does on its own is outside
  course_kit's control) and adds a few seconds of CLI start-up. Costs show as `subscription`.
- **Status.** `course serve`/`dev` print the provider and whether it is ready; the panel says when
  the CLI is missing or not logged in, with the command to run.
- **Cursor keeps transcripts.** `cursor-agent` has no option to turn them off: it writes each
  conversation (including the lesson materials) under `~/.cursor/projects/<temp-dir-name>/`.
  course_kit itself still stores nothing.
  Voice input is designed but not implemented yet. Step-4 workspaces get the panel after copying
  `addons/chat`, adding `"slidev-addon-course-chat": "file:addons/chat"` and `"course-chat"` to
  `package.json` (`devDependencies`, `slidev.addons`) and running `npm install`.

### Example

[`examples/faktura`](examples/faktura) is a real workspace for the
[faktura](https://github.com/Kasperone/faktura) repo with lesson `01-architecture` in English and Polish (13
slides, sources on every slide, speaker notes per click, 57 narration steps per language):

```bash
npm ci --prefix examples/faktura
node dist/cli.js narrate 01-architecture -C examples/faktura --lang all   # optional; needs Piper + voices
node dist/cli.js build -C examples/faktura
node dist/cli.js serve -C examples/faktura     # http://127.0.0.1:8787/ (chat needs the pack + key)
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

| Artifact                                      | License                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Software in this repo (CLI, tooling)          | [MIT](LICENSE)                                                                          |
| Lesson text in course workspaces (`lessons/`) | [CC BY 4.0](LICENSE-CONTENT) — each generated workspace ships its own `LICENSE-CONTENT` |
| Generated audio                               | Never committed (`audio/local/`, gitignored); voice licences in `audio/ATTRIBUTION.md`  |
| Piper (external TTS program, not bundled)     | GPL-3.0-or-later; installed by the user, run as a separate process                      |
| Chat answers                                  | Never stored; shown in the panel or the terminal only                                   |

## Docs

- [ADR 0001 — stack & repo reference](docs/adr/0001-node-typescript-cli-and-repo-reference.md)
- [ADR 0002 — context-pack format](docs/adr/0002-context-pack-format.md)
- [ADR 0003 — Slidev build and live preview](docs/adr/0003-slidev-build-and-dev.md)
- [ADR 0004 — narration: per-click clips, TTS adapters, cache, licences](docs/adr/0004-narration-tts-adapters.md)
- [ADR 0005 — local Q&A backend and chat panel](docs/adr/0005-local-qa-backend-and-chat.md)
- [AGENTS.md](AGENTS.md) — conventions for coding agents in this repo
