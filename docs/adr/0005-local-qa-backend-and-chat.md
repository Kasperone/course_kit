# ADR 0005: Local Q&A backend and chat panel

## Status

Accepted (step 5). Voice input is designed here but not implemented yet.

## Context

Learners watching a lesson deck need to ask questions about it. Answers must come only from the
lesson's context pack (ADR 0002) and its slides and speaker notes, in the deck's language, and say
clearly what is not from the lesson. The decks stay fully offline (ADR 0003): deck code may only
call its own origin or loopback. API keys must never reach the browser.

## Decision

### Process model

- The backend runs **inside course_kit**, on `node:http`, bound to **127.0.0.1 only** (there is no
  host option).
  - `course serve [-C] [--port 8787] [--model] [--no-chat]` serves the built `dist/` and the API
    from **one origin**. It replaces `npx vite preview` as the way to view a built course, and it
    answers single byte ranges, so narration clips can seek.
  - `course dev <lesson> [--model] [--no-chat]` starts the backend on an ephemeral loopback port
    and passes it to Slidev as `COURSE_CHAT_PORT`. The chat addon's Vite plugin proxies
    `/@course-chat/` there with `changeOrigin: false`, so the browser still sees one origin and the
    backend's Host and Origin checks still apply. The e2e test checks that SSE is not buffered by
    the proxy.
  - `course ask <lesson> [question] [--dry-run]` runs the same pipeline in the terminal.
    `--dry-run` prints prompt sizes and a cost estimate without a key or network; CI runs it.
- The deck calls only the same-origin path `/@course-chat/v1/`. The `status` response carries an
  `apiVersion`, so an addon that no longer matches the CLI says "update the addon" instead of
  failing.
- **Framework.** `node:http` with a small router rather than Express, Fastify or Hono. There are
  two routes plus static files, and every hard requirement needs direct control anyway: exact Host
  and Origin checks, byte-counted body limits, SSE flushing, and aborting upstream on disconnect.
  Nothing is added except the SDK.
- **Claude client.** The official `@anthropic-ai/sdk` (Apache-2.0), loaded with a dynamic `import()`
  only on the chat path. It gives typed stream events, retries and typed errors.
- The server is stateless. The panel keeps the conversation in memory and sends the last turns;
  nothing is stored.

### HTTP API

| Route                    | Request                                                                                                             | Response                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET status?lesson&lang` | –                                                                                                                   | `{apiVersion, answers: ready\|no-key\|disabled, model, pack: ok\|missing\|stale\|too-large, problem, packCommit, pinnedCommit, promptTokens, slides, limits, stt: "off"}`. No upstream call |
| `POST ask`               | JSON ≤ 32 KB: `{lesson, lang, slide, click, question ≤ 2000 chars, history ≤ 6 turns}`. Unknown fields are rejected | `text/event-stream`                                                                                                                                                                         |

SSE events on `ask`:

| Event                        | Meaning                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `start`                      | The answer has begun                                                                         |
| `delta {text, source}`       | A piece of answer text; `source` is `lesson` or `general`                                    |
| `scope {value: "off-topic"}` | The question is unrelated to the lesson                                                      |
| `done {stopReason, usage}`   | The answer is complete. `max_tokens` means it was cut off                                    |
| `error {code, message}`      | Codes: `refused`, `auth`, `offline`, `rate-limited`, `overloaded`, `bad-request`, `upstream` |

A `: ping` comment goes out every 15 s. Errors found before the stream starts are JSON with an HTTP
status: 400, 403, 404, 405, 413, 415, 422 (`no-pack`, `too-large`), 429 (with `Retry-After`) or 503
(`no-key`, `disabled`).

### Security

- **DNS rebinding.** The Host header must be `localhost`, `127.0.0.1` or `[::1]` (any port), for
  the API and the static files alike.
- **Origin.**
  - When present, Origin must equal `http://<Host>`. A POST without Origin is refused.
  - `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`.
  - No CORS headers are ever sent, and OPTIONS returns 405.
- **Input.**
  - `Content-Type: application/json`, a 32 KB body cap (checked against Content-Length and while
    reading), and strict field validation.
  - Lesson ids and languages go through the existing validators. The deck and pack must not be
    reached through a symlink.
  - Error messages never contain the workspace path.
- **Static files.**
  - GET and HEAD only, decoded once. Requests with NUL, a backslash, `.` or `..` are refused.
  - The path must stay inside `dist/`, with no symlink in any path component.
  - Redirects are built from validated path segments only.
- **Limits.** 6 questions a minute, 200 a day and 1 at a time (`chat.rateLimit`); the excess gets a 429. When the browser goes away, the upstream request is aborted, so no more output is billed.
- **Keys.**
  - `ANTHROPIC_API_KEY` comes only from the environment or the workspace's gitignored `.env`
    (`readWorkspaceSecret`, shared with ElevenLabs).
  - It is passed explicitly to the SDK with `authToken: null`, so no other credential source is
    used. A server-side proxy configured through `ANTHROPIC_BASE_URL` in the user's own environment
    is respected.
  - Every message the backend can emit passes through `redactSecrets`. Logs carry timings and token
    counts, never questions, answers or keys.
  - Slidev (`course dev`, `course build`) runs without `ANTHROPIC_*` and `ELEVENLABS_API_KEY` in its
    environment.
  - `course build` fails if the output contains a workspace key or `api.anthropic.com` /
    `api.elevenlabs.io`.

### Grounding and prompt (no RAG)

The prompt has two system blocks, both static for a given (lesson, language):

1. **Instructions** (`PROMPT_VERSION` 1).
2. **Lesson materials** in `<lesson_materials>`, carrying the only cache breakpoint (`ephemeral`;
   `chat.cacheTtl` `5m` or `1h`). They contain:
   - the deck-language slides: body Markdown, title, and notes split into `[click n]` steps exactly
     like narration;
   - the whole `context-pack.md`.

The history, the `<viewer_position slide click title>` (with that step's narration) and the
`<question>` go in `messages`, after the breakpoint. For faktura lesson 01 the cached prefix is
~23k tokens.

**Budget.**

| Limit            | Default                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| Pack             | 60k tokens (`chat.maxPackTokens`)                                        |
| Slides and notes | 20k tokens                                                               |
| Whole prompt     | 100k tokens                                                              |
| Output           | 8000 tokens (`chat.maxOutputTokens`); adaptive thinking counts toward it |

Nothing is truncated silently, except the oldest history turns.

**Pack state.**

| State                                         | Behaviour                                                 |
| --------------------------------------------- | --------------------------------------------------------- |
| Missing                                       | No answers; the message says to run `course context <id>` |
| Built from another commit than `pinnedCommit` | Answers, with a "stale" note in the panel                 |
| Over the cap                                  | No answers, with advice to narrow `lesson.json`           |

**Topics and sources** (Kasper, 2026-11-21):

- Every question related to the lesson's subject (the repo, Java, Spring, security, architecture,
  tooling) is answered; nothing related is refused.
- The model writes `[[general]]` before any part that is not backed by the lesson materials, and
  `[[lesson]]` when it returns to lesson-backed text.
- Unrelated questions start with `[[off-topic]]` and get a short redirect.
- `SourceSplitter` removes the markers from the stream, even when a marker is split across chunks,
  and labels each delta.
- The panel shows general parts under **Not from this lesson**. `course ask` prints
  `[not from this lesson]`.

**Prompt injection.**

- Everything in `<lesson_materials>` is declared as data, never instructions. Any frame tag inside
  repository text (`</context_pack>`, `<question>`, …) is escaped.
- The model has no tools.
- The panel renders only paragraphs, lists, inline code, bold and fenced code. It never uses
  `v-html` and never renders links or images, so an injected answer cannot make the browser load
  anything.
- What remains is misleading text, which the required citations make checkable.

### Model and configuration

- **Default model.** `claude-sonnet-5-5` with `output_config.effort: "low"` and adaptive thinking.
  Thinking text is not shown; the panel shows "Thinking…" until the first text.
- **Choosing the model.** `--model`, then `COURSE_CHAT_MODEL`, then `course.json` `chat.model`, then
  the default. Opus 5.5 and Haiku 5.5 are selectable. Model ids are validated
  (`^claude-[a-z0-9-]+$`).
- **Requests.** No `temperature` or prefill.
- **Refusals.** `stop_reason: "refusal"` becomes the `refused` error.
- **Refusal fallback.** `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) is on by
  default (`chat.refusalFallback`). It is sent only for models that support it (Opus/Fable 5.x and
  Sonnet 5.5, not Haiku).
- **`course.json` `chat`.** Optional and validated; unknown fields are errors, and `course pin`
  keeps the block. It holds `enabled`, `model`, `effort`, `maxOutputTokens`, `maxPackTokens`,
  `historyTurns`, `cacheTtl`, `refusalFallback`, `rateLimit`, `port` and `stt`.
- **Estimated cost** for faktura lesson 01 with ~1k output tokens:

  | Model      | First question | Within the cache TTL |
  | ---------- | -------------- | -------------------- |
  | Sonnet 5.5 | ~$0.07         | ~$0.015              |
  | Opus 5.5   | ~$0.14         | ~$0.025              |
  | Haiku 5.5  | ~$0.004        | ~$0.001              |

### Deck UI (`addons/chat`, `slidev-addon-course-chat`)

- **Placement.** A separate local addon next to narration, in the template and the example. A test
  keeps the template and the example identical.
- **Visibility.** The "Ask" button shows on the main slideshow only, not in presenter, print or
  embedded views. The panel is teleported to `body`, so it is not scaled with the slide.
  - Escape closes it. Enter sends and Shift+Enter adds a line.
  - Panel keys never reach Slidev's shortcuts.
- **Context and states.**
  - Each question carries `currentSlideNo` and `clicks`.
  - The panel states are checking, ready, stale, no key, no pack, too large, disabled, backend not
    running and outdated addon. UI strings are in English and Polish.
- **Code layout.** The logic lives in `chat-client.ts` (SSE parser, Markdown subset, states,
  strings), so vitest can test it without Vue. The addon has no external URL anywhere, so the
  existing deck-code policy covers it.

### Voice input (designed, not implemented)

- **Flow.**
  - `MediaRecorder` in the panel (localhost is a secure context), stopping at 60 s.
  - The audio goes to `POST /@course-chat/v1/transcribe` (≤ 4 MB, allowlisted audio types).
  - The transcript goes into the question box **for review**. It is never sent automatically.
- **Providers**, through an `SttProvider` interface selected by `chat.stt.provider`:
  - **whisper.cpp:** an external `whisper-cli` (`WHISPER_BIN`), never built, bundled or installed by
    course_kit.
    - Models are pinned with sha256 and installed by `course stt install whisper <model>` into
      `~/.cache/course_kit/whisper-models/`.
    - ffmpeg converts the input to 16 kHz mono WAV. That is STT _input_, so ADR 0004's "never
      resample TTS output" rule does not apply.
    - A glossary of identifiers from the slides is passed as `--prompt`.
  - **ElevenLabs Scribe:** opt-in, using the same key loader and redaction.
- Until then, `status.stt` is `"off"` and the panel has no microphone button.

### Testing

| Area                                          | How it is tested                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                                    | Config, prompt and materials (including a hostile pack), `SourceSplitter`, the server's guards, limits, SSE and abort with a fake provider, static serving, and the CLI commands                                                                                                             |
| Anthropic provider                            | The **real SDK** against a local mock of the Messages API (request shape, streaming, refusal, error codes, abort, key redaction)                                                                                                                                                             |
| Network                                       | `tests/setup.ts` rejects any `fetch` to a non-loopback host, so a live API call in a test is impossible                                                                                                                                                                                      |
| E2E (`tests/chat-e2e.test.ts`, CI `deck` job) | Real Slidev 52.20.1 builds a probe workspace. The bundle carries the chat config, and a deck outside `lessons/` does not (negative control). `course serve` answers on one origin and refuses a foreign Origin and a rebinding Host. Through the dev server, the proxy streams incrementally |
| Manual                                        | A headless-browser check of the built faktura deck with a mock API: the answer streams, the general part has its badge, the slide link navigates, no anchors or images appear, and only 127.0.0.1 requests are made                                                                          |

## Alternatives considered

| Alternative                           | Why not                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Express, Fastify or Hono              | More dependencies for two routes; still needs custom guards                                                            |
| A cross-origin backend with CORS      | Needs CORS configuration and a looser URL policy in deck code. Same-origin needs neither                               |
| The API inside the Slidev/Vite plugin | Keys would sit in the Vite process, built decks would have no backend, and the logic would be duplicated per workspace |
| Raw `fetch` to the Messages API       | The official SDK gives typed streaming, errors and retries                                                             |
| EventSource or WebSockets             | EventSource cannot POST; WebSockets are unnecessary for one-way streaming                                              |
| Server-side sessions                  | State to secure and expire, with no benefit for a single local learner                                                 |
| RAG or a vector DB                    | Packs are per lesson and sized for a prompt (~18k tokens for faktura); prompt caching makes re-sending them cheap      |
| Browser-side Whisper (WASM)           | A large model download conflicts with the offline and size goals                                                       |

## Consequences

- One new runtime dependency, `@anthropic-ai/sdk` (Apache-2.0).
- Each question costs money (see the table above) and sends the lesson materials, including quoted
  repository code, to Anthropic. The panel says so.
- Step-4 workspaces need `addons/chat`, two `package.json` entries and `npm install`.
- The prompt is versioned (`PROMPT_VERSION`). Changing the instructions changes the cached prefix,
  which costs one cache write per lesson and language.
