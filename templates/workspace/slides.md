---
theme: default
title: course_kit workspace
drawings:
  persist: false
---

# Course workspace

Lessons live under `lessons/<lang>/`. This deck is the Slidev entry point for local preview.

```mermaid
flowchart TB
  lessons[lessons/] --> slidev[Slidev]
  audio[audio/local/] --> narration[Narration later]
```
