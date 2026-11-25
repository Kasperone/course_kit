import { fence, inlineCode, numberedExcerpt } from './markdown.js'

export const DOC_CANDIDATES = ['README.md', 'readme.md', 'AGENTS.md', 'CLAUDE.md']

export type DocInput = {
  path: string
  text: string | null
  /** Already embedded in full under "Selected sources" (avoid duplicating it). */
  includedInSources: boolean
}

export function buildDocExcerpts(docs: DocInput[], maxLines: number): string {
  const sections: string[] = []
  for (const doc of docs) {
    if (doc.includedInSources) {
      sections.push(
        `### ${inlineCode(doc.path)}`,
        '',
        '_Included in full under Selected sources._',
        '',
      )
      continue
    }
    if (!doc.text) continue
    // Line-numbered like selected sources, so a doc's own fences (e.g. a PlantUML block) never
    // start at column 0 of the pack.
    const { text, truncated } = numberedExcerpt(doc.text, maxLines)
    sections.push(`### ${inlineCode(doc.path)}`, '', fence(text))
    if (truncated > 0) sections.push(`_… first ${maxLines} lines shown._`)
    sections.push('')
  }
  if (sections.length === 0) {
    return '_No README/AGENTS.md/CLAUDE.md at this commit._\n'
  }
  return sections.join('\n')
}
