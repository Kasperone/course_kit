# course_kit

Turn any code repository into an interactive, narrated browser course (Slidev decks in Polish and English),
authored together with a coding agent. Point `course` at a repo; it creates a separate workspace pinned to a
commit of that target. Runs locally only — no GitHub Pages.

**Status:** early WIP (step 4: narration with `course narrate` (Piper offline or ElevenLabs), an in-deck
player, and the Polish version of the first real lesson in
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
course dev 02-invoices --lang en     # live preview on localhost
course build                         # dist/<lesson>/<lang>/ + dist/index.html
npx vite preview --outDir dist       # serve dist/ at http://localhost:4173

# 5. Narrate: one clip per slide/click step of the speaker notes (see "Narration")
course narrate 02-invoices --lang all          # Piper, offline; audio/local/<lang>/02-invoices/
course build                                   # copies the clips next to the decks
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
slide `src:` import, `<<<` snippet or local image/asset path leaves the checked files (or reads a context pack or a secret-looking file such as `.env`). `course dev` checks when it starts; `course build` is the gate for
later edits. Slidev runs without your API keys in its environment. The
build fails if its output references plantuml.com, a font CDN or the jsDelivr favicon. `course build` does not
need the target repo.

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
  `ffmpeg` on `PATH` (or `FFMPEG_BIN`); without it, clips are written as WAV with a warning. Piper and ffmpeg run without your API keys in their
  environment (they get `PATH`, `HOME`, user name, locale, `XDG_*`, temp dir, terminal variables and, for Piper, `PIPER_*`/`ESPEAK_*`/library paths; no proxy, ssh or git variables) and are stopped if they hang.

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

### Example

[`examples/faktura`](examples/faktura) is a real workspace for the
[faktura](https://github.com/Kasperone/faktura) repo with lesson `01-architecture` in English and Polish (13
slides, sources on every slide, speaker notes per click, 57 narration steps per language):

```bash
npm ci --prefix examples/faktura
node dist/cli.js narrate 01-architecture -C examples/faktura --lang all   # optional; needs Piper + voices
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
| Generated audio                               | Never committed (`audio/local/`, gitignored); voice licences in `audio/ATTRIBUTION.md`                                                                |
| Piper (external TTS program, not bundled)     | GPL-3.0-or-later; installed by the user, run as a separate process                                                                                    |

## Docs

- [ADR 0001 — stack & repo reference](docs/adr/0001-node-typescript-cli-and-repo-reference.md)
- [ADR 0002 — context-pack format](docs/adr/0002-context-pack-format.md)
- [ADR 0003 — Slidev build and live preview](docs/adr/0003-slidev-build-and-dev.md)
- [ADR 0004 — narration: per-click clips, TTS adapters, cache, licences](docs/adr/0004-narration-tts-adapters.md)
- [AGENTS.md](AGENTS.md) — conventions for coding agents in this repo
