/**
 * Slidev renders ```plantuml blocks as `<img src="${plantUmlServer}/svg/...">` (default server:
 * plantuml.com). A data: URL turns that into a local no-op, so diagram source never leaves the
 * machine. The workspace also ships scripts/check-no-plantuml.mjs, which fails dev/build/export.
 */
export const PLANTUML_DISABLED_SERVER = 'data:text/plain,plantuml-disabled'

/**
 * System font stacks with no web-font provider: Slidev then emits no Google Fonts `<link>`, so a
 * deck makes no font requests (fully offline). Slidev appends its own fallback stacks.
 */
export const SYSTEM_FONTS = {
  sans: 'system-ui',
  serif: 'ui-serif',
  mono: 'ui-monospace',
  provider: 'none',
} as const

/**
 * Slidev's default favicon is hosted on cdn.jsdelivr.net. An empty data: URL loads nothing; a
 * /favicon.svg path would break under `slidev build --base` and lesson decks have their own root.
 */
export const NO_FAVICON = 'data:,'

/**
 * Headmatter for a generated deck. Values are emitted as JSON strings, which are valid YAML
 * scalars, so titles containing `: `, quotes or `#` cannot break the frontmatter. Besides title
 * and language, it pins the offline policy: no PlantUML server, web fonts or CDN favicon.
 */
export function deckFrontmatter(fields: { title: string; lang: string }): string {
  return [
    '---',
    'theme: default',
    `title: ${JSON.stringify(fields.title)}`,
    `lang: ${JSON.stringify(fields.lang)}`,
    `plantUmlServer: ${JSON.stringify(PLANTUML_DISABLED_SERVER)}`,
    'fonts:',
    ...Object.entries(SYSTEM_FONTS).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    `favicon: ${JSON.stringify(NO_FAVICON)}`,
    '---',
  ].join('\n')
}
