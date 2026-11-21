# Audio attribution

Narration clips are **generated** by `course narrate` into `audio/local/<lang>/<lesson>/`, which is
gitignored. They are build artefacts: **never commit generated audio** (or API keys). `course build`
copies them into `dist/` (also gitignored) for local viewing.

## Voices

| Lang | Provider / voice | Voice training data | Data licence | Model |
|---|---|---|---|---|
| pl | Piper `pl_PL-darkman-medium` | darkman, https://github.com/OHF-Voice/voice-datasets | CC0 | Finetuned from the rdh base model (nl_BE, CC0) |
| en | Piper `en_US-ljspeech-medium` | LJ Speech, https://keithito.com/LJ-Speech-Dataset/ | Public domain | Trained from scratch on LJ Speech |

- Piper voices come from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) at revision
  `e9c8a39444359388adaa94255becb37a5a2b8e51` (repository licence: MIT), installed with
  `course voices install piper <voice>` and checked against pinned sha256 hashes. Each voice's
  `MODEL_CARD` is stored next to it in the voice cache.
- The Piper engine (OHF-Voice/piper1-gpl, GPL-3.0-or-later) runs as a separate program; it is not
  part of this workspace. The GPL covers the program, not in general the output it produces (see
  the GNU GPL FAQ on program output); the voice data licences above are what matter for the clips.
- Clips say which provider, voice and model produced them in `manifest.json`.

## ElevenLabs

If a lesson is narrated with `--provider elevenlabs`, the clips stay in `audio/local/` like any
other narration. Use and publishing are governed by your ElevenLabs plan's terms (the free plan is
non-commercial and requires attribution). Record the voice id and plan here before sharing a build:

| Lang | Voice id | Model | Plan / licence |
|---|---|---|---|
|  |  |  |  |
