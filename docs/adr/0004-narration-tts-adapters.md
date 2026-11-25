# ADR 0004: Narration — per-click clips, TTS adapters, cache and licences

## Status

Accepted (step 4)

## Context

Lesson decks already carry narration scripts: each slide's speaker notes (its last HTML comment)
are plain spoken text with one Slidev `[click]` marker per `v-click` reveal (step 3). Step 4 turns
them into audio that plays in the deck, in English and Polish, with an offline default and an
optional paid provider, without breaking the offline deck policy (ADR 0003) and without ever
committing generated audio or API keys.

## Decision

### One clip per (slide, click)

- `course narrate <lesson-id> [--lang en|pl|all] [--provider piper|elevenlabs] [--voice <id>]
[--model <id>] [--force] [--prune] [--dry-run] [-C dir]`.
- Notes are found and split exactly as Slidev 52 does it (`src/lib/narration/notes.ts` mirrors
  `@slidev/parser`: `---` separators outside code fences and HTML comments, per-slide frontmatter,
  "last comment that ends the slide"). Click markers are numbered like Slidev's note renderer:
  `[click]` adds 1, `[click:n]` adds n. Text before the first marker is click 0. A step is
  therefore exactly the state shown at `#/<slide>?clicks=<click>`. Verified against the real
  parser on the faktura decks (identical notes for all 13 slides).
- Markup is stripped for speech (tags, `**`, backticks, link targets); whitespace collapsed.
- Why per-click clips and not one file per slide with timestamps: step timing comes from clip
  boundaries, so any TTS works (Piper has no word timestamps), and an edited step re-synthesizes
  only that step.
- Polish and English decks of a lesson must have the same (slide, click) steps so the player can
  switch narration language on any slide; a test enforces this for the example.

### Output, cache and manifest

- Clips go to `audio/local/<lang>/<lesson>/` (gitignored), named `s<slide>-c<click>-<key12>.<ext>`.
- Cache key: `sha256(JSON{text, provider, voice, model, settings})` with sorted settings. Settings
  hold everything else that changes the audio (Piper: length/noise scales, sentence silence, sample
  rate, channels, quality preset, format, effective bitrate; ElevenLabs: quality preset, output
  format, format, bitrate). For Piper, `model` includes the sha256 of the
  `.onnx` file. An existing non-empty file with that name is reused if it is valid audio (its duration
  can be read); otherwise it is regenerated. A provider response is validated before it is cached, so
  a proxy's HTML page or a truncated MP3 never stays in the cache (the error names the clip). A WAV
  whose data chunk is shorter than its header declares (the streamed placeholders `0` and
  `0xFFFFFFFF` aside) and an MP3 whose last frame is cut off are not valid audio. Clips and the
  manifest are written to `<file>.part` and renamed into place, so an interrupted run (Ctrl-C, full
  disk) leaves no half-written clip under its real name; leftover `.part` files are removed at the
  start of the next run. `--force` regenerates. All providers are built, and the never-commit guard
  runs, for every language before the first clip is synthesized (`--lang all --voice <pl voice>`
  fails before Polish is narrated, not after).
- Older clips that a new manifest no longer uses are kept (switching providers back and forth must
  not pay a paid provider twice) and reported; `--prune` deletes them.
- `manifest.json` next to the clips: lesson, lang, provider, voice, model, format, settings,
  `totalDuration` and per clip `{slide, click, file, duration, key, text}`. Durations are read from
  the audio itself (WAV header, MP3 frame walk), not estimated.
- `--dry-run` prints steps and character counts (a cost check before a paid run) and writes nothing.
- Engine version is not in the key: after upgrading Piper, run with `--force`.

### Audio quality presets

`--audio-quality compact|standard|high|lossless`, or `course.json` `"audioQuality"` (validated). The
CLI flag wins over `course.json`, and the default is `standard`. `course pin` keeps the field.

| Preset     | Piper                                            | ElevenLabs `output_format`              | Faktura `01-architecture`, EN + PL (Piper) |
| ---------- | ------------------------------------------------ | --------------------------------------- | ------------------------------------------ |
| `compact`  | MP3 64 kbit/s                                    | `mp3_44100_64`                          | 11.3 MB                                    |
| `standard` | MP3 128 kbit/s                                   | `mp3_44100_128`                         | 22.6 MB                                    |
| `high`     | MP3 192 kbit/s requested; 160 at 22.05 kHz       | `mp3_44100_192` (Creator tier or above) | 28.3 MB                                    |
| `lossless` | WAV: Piper's PCM in a WAV header, not re-encoded | `wav_44100` (Pro tier or above)         | 62.0 MB                                    |

The sizes cover 114 clips and 23.5 minutes of speech, measured 2026-11-21. The tier notes come from
the ElevenLabs API docs.

- **The sample rate and channels are never changed.** ffmpeg gets no `-ar`/`-ac`. After encoding,
  the MP3's first frame header is compared with the source WAV's sample rate and channel count, and
  a mismatch is an error. There is no upsampling, resampling or downmixing.
- MP3 at MPEG-2 rates (below 32 kHz, so Piper's 22.05 kHz voices) tops out at 160 kbit/s.
  Encoders silently cap a higher request, so `high` caps it explicitly, warns, and records the
  effective bitrate in the settings and the cache key. Upsampling just to reach 192 kbit/s would add
  size without adding audio.
- ElevenLabs audio is stored exactly as delivered, at 44.1 kHz.
- The manifest records `format` and `settings.quality`/`settings.bitrate`. The player, the
  `course dev` middleware and `course build` handle `.mp3` and `.wav` clips alike, which was checked
  in a headless browser with lossless WAV clips.

### Provider adapters

A provider is `{ id, voice, model, settings, format, synthesize(text): Promise<Buffer> }`
(`src/lib/narration/providers.ts`). Tests use a fake provider, a fake `piper` executable and a
mocked `fetch`; CI needs neither Piper, voices, ffmpeg nor an API key.

**Piper (default, offline).**

- `OHF-Voice/piper1-gpl`, PyPI `piper-tts` 1.8.0, installed by the user in a venv
  (`~/.local/share/course_kit/piper-venv`, see README). `PIPER_BIN` overrides; otherwise the venv
  binary, then `piper` on `PATH`.
- Run with `--output-raw`; the text goes in on **stdin** (never argv, where a leading `-` would be
  an option). course_kit wraps the 16-bit PCM in a WAV header. For the MP3 presets it then encodes
  through `ffmpeg` (`FFMPEG_BIN` or `PATH`) over stdin/stdout, at the preset's bitrate and the
  voice's own sample rate and channels. `lossless` keeps the WAV. Without ffmpeg it writes WAV and
  warns. No temp files, no shell.
- Piper and ffmpeg run with an allowlisted environment (`piperEnv()`/`ffmpegEnv()` in
  `src/lib/narration/env.ts`, built on `childEnv()` minus what these tools never use: proxy
  variables, `SSH_AUTH_SOCK` and `GIT_*`): `PATH`, `HOME`, `USER`/`LOGNAME`, locale, `XDG_*`, temp dir
  and terminal variables, plus `PIPER_*`, `ESPEAK_*`, `LD_LIBRARY_PATH`/`DYLD_*` and `OMP_*`/`ORT_*` for Piper.
  Credential-looking names (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) never pass, so an
  exported `ELEVENLABS_API_KEY` stays in this process (the ElevenLabs HTTP call) and reaches no child.
- Nothing waits forever (`src/lib/narration/timeouts.ts`): Piper 5 min per clip, ffmpeg 2 min per
  encode (both killed with SIGKILL), probes 30 s, an ElevenLabs request 2 min including its body
  (a timeout is retried like a 429/5xx), a voice download 15 min.
- **GPL boundary.** Piper is GPL-3.0-or-later. course_kit (MIT) only executes it as a separate
  program and exchanges data over pipes. It never vendors, bundles, links or imports Piper, never
  installs it, and its npm package contains no Piper code. Users install Piper themselves.
- **Voices.** Installed only by `course voices install piper <voice>` (narrate never downloads).
  The registry in `src/lib/narration/voices.ts` pins `rhasspy/piper-voices` (MIT) at revision
  `e9c8a39444359388adaa94255becb37a5a2b8e51` and the sha256 of each voice's `.onnx`, `.onnx.json`
  and `MODEL_CARD`. Files are verified before they are moved into place, into
  `COURSE_KIT_VOICES_DIR` (default `~/.cache/course_kit/piper-voices/<voice>/`), never a repo.
  The model card is stored next to the voice.
- Only voices whose training data allows redistributing the generated audio are listed (from each
  `MODEL_CARD` at the pinned revision):

  | Voice                                  | Data                              | Licence       | Model                                                |
  | -------------------------------------- | --------------------------------- | ------------- | ---------------------------------------------------- |
  | `pl_PL-darkman-medium` (default `pl`)  | darkman, OHF-Voice/voice-datasets | CC0           | finetuned from the rdh base (CC0); needs Piper ≥ 1.5 |
  | `en_US-ljspeech-medium` (default `en`) | LJ Speech                         | public domain | trained from scratch                                 |

  Rejected: `pl_PL-mc_speech` (excluded by the brief), `en_US-lessac` (Blizzard 2013 Lessac
  licence, research use), `en_US-ryan` / `hfc_*` (CC BY-NC-SA data). `en_GB-cori` (CC BY 4.0)
  would also qualify but needs attribution.

- A voice whose language differs from the deck's is refused.

**ElevenLabs (optional, paid).**

- `POST https://api.elevenlabs.io/v1/text-to-speech/<voice>?output_format=<preset format>` with
  `{text, model_id}`; default model `eleven_multilingual_v2` (it normalises numbers). Voice and
  model ids are validated before they go into the URL. 429/5xx are retried twice. The request uses
  `redirect: 'error'`: Node's fetch forwards a custom header such as `xi-api-key` across origins on a
  redirect, and the endpoint never needs one.
- The key comes only from `ELEVENLABS_API_KEY` in the environment or the workspace's gitignored
  `.env`. It is sent only in the `xi-api-key` header. It is never printed, logged, written to a
  manifest or file, or included in an error message (any occurrence in a provider error is
  replaced, before the text is cut to its 300-character limit, so a key at the cut leaves no
  prefix). Tests assert this with a mocked HTTP layer; there are no live calls.

### Never commit generated audio

- Before writing, `course narrate` checks (when the workspace is in a git work tree) that every
  kind of file a run writes (an MP3 clip, a WAV clip, `manifest.json`) under
  `audio/local/<lang>/<lesson>/` is ignored by git, so a narrower rule such as
  `audio/local/**/*.mp3` fails, and that nothing under `audio/local/` except `.gitkeep` is tracked.
  Otherwise it stops before calling any provider. Its git calls use the same hardening arguments
  as calls on a target repository (a workspace can be a clone of someone else's). The guard only
  steps aside when there is nothing to commit to: no `git` binary, or git answering "not a git
  repository". Git older than 2.43 (the "please upgrade" error of `init` and `pin`), a timeout,
  "dubious ownership" or any other failure of `rev-parse`, `check-ignore` or `ls-files` refuses the
  run instead of passing silently.
- course_kit's own test suite fails if the repository tracks any audio file.
- `audio/ATTRIBUTION.md` (generated from the voice registry by `course init`) names the voices,
  data licences and the never-commit rule, with a table to fill in for ElevenLabs voices.

### Player (Slidev addon)

- The workspace template ships a local addon `addons/narration` (npm `file:` dependency
  `slidev-addon-course-narration`, enabled for every deck via `package.json` `"slidev": {"addons":
["course-narration"]}`). Slidev resolves local addon paths in headmatter relative to the
  lesson's parent directory, so a package is the robust way to share one addon between all
  `lessons/<id>/<lang>/` decks.
- `global-top.vue`: a small top-right control on the main slideshow (not presenter, print or
  embedded views): narration on/off, an "auto" toggle (advance when a clip ends), language
  buttons for every course language, and a status line. It plays the clip for the current
  `currentSlideNo` and `clicks` and re-plays on navigation while narration is on. A rejected
  `play()` switches narration off only when the browser refuses (autoplay, unsupported format);
  an `AbortError` (a newer clip or pause interrupted it, e.g. pressing "next" twice) is ignored
  (`playback.ts`). Nothing plays
  until the viewer turns narration on. A missing manifest or clip shows a dimmed "no narration" /
  "no clip" state; the deck keeps working. Settings persist in `localStorage` when available.
- `setup/vite-plugins.ts`: defines `__COURSE_NARRATION__` (`{lesson, lang, langs, base}`) from the
  deck's path and `course.json`. In `course dev` it serves `audio/local/<lang>/<lesson>/` at
  `/@course-narration/<lang>/<file>`; only `manifest.json` and clip-shaped names, only course
  languages, never symlinks (the real path must stay under `audio/local/`, so a symlinked lesson
  directory is refused too); a malformed `%`-escape is a 404. Other decks (the root `slides.md`) get `null` and no player.
- `course build` copies each built lesson's manifests and the clips they list (validated names,
  no symlinks) to `dist/<lesson>/narration/<lang>/` for every course language; the player reaches
  it as `../narration/<lang>/` from the deck base. `--no-narration` skips the copy. `dist/` is
  gitignored.

### Offline policy (extends ADR 0003)

- The player only fetches same-origin relative URLs and only clip names matching the manifest
  pattern.
- `course build`/`course dev` and the template's `scripts/check-deck.mjs` now also refuse deck
  code (`.vue`, `.ts`, `.js`, `.mjs`, … outside `node_modules`, `dist`, `audio`, `scripts`) that
  references an external URL (`http(s)://`, `ws(s)://` or protocol-relative); loopback hosts are
  allowed. Inline `<script>` blocks in a slide's Markdown (outside code fences) are scanned too:
  Slidev compiles them into the slide's component. XML namespace identifiers
  (`xmlns="http://www.w3.org/2000/svg"`, `createElementNS("http://www.w3.org/2000/svg", …)`) are
  names, not requests, and are ignored.
- Checked in a headless browser on the built faktura deck and on `course dev`: turning narration
  on at slide 1 loads `s01-c00-….mp3` from localhost and starts playback; navigation and the
  language switch load the matching clips; no request leaves localhost.

## Consequences

- Narration is reproducible from the notes and cached; editing one sentence costs one clip.
- The notes stay the single script: lesson authors keep one `[click]` per reveal in both
  languages.
- Piper output quality is modest (especially English identifiers read by a Polish voice); a paid
  provider is one flag away and shares the same cache, manifest and player.
- Existing step-3 workspaces get the player after copying `addons/narration`, adding the two
  `package.json` entries and running `npm install`.
