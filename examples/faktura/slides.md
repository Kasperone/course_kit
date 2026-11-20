---
theme: default
title: course_kit workspace
# Never send diagram source to plantuml.com: Slidev turns ```plantuml blocks into
# <img src="${plantUmlServer}/svg/...">. A data: URL makes that a local no-op.
plantUmlServer: 'data:text/plain,plantuml-disabled'
drawings:
  persist: false
---

# Course workspace

Lessons live under `lessons/`. This deck is the Slidev entry point for local preview.

```mermaid
flowchart TB
  lessons[lessons/] --> slidev[Slidev]
  audio[audio/local/] --> narration[Narration later]
```
