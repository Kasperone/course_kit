---
theme: default
title: course_kit workspace
# Never send diagram source to plantuml.com: Slidev turns ```plantuml blocks into
# <img src="${plantUmlServer}/svg/...">. A data: URL makes that a local no-op.
plantUmlServer: 'data:text/plain,plantuml-disabled'
# Fully offline: system fonts, no Google Fonts requests (Slidev's default provider is Google).
fonts:
  sans: 'system-ui'
  serif: 'ui-serif'
  mono: 'ui-monospace'
  provider: 'none'
# No export: no /export page in the dev server, no PDF download in builds.
browserExporter: false
download: false
# Slidev's default favicon is loaded from cdn.jsdelivr.net; an empty data: URL loads nothing.
favicon: 'data:,'
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
