import { fence, inlineCode } from './markdown.js'

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
    const all = doc.text.split('\n')
    const lines = all.slice(0, maxLines)
    sections.push(`### ${inlineCode(doc.path)}`, '', fence(lines.join('\n'), 'markdown'))
    if (lines.length < all.length) sections.push(`_… first ${maxLines} lines shown._`)
    sections.push('')
  }
  if (sections.length === 0) {
    return '_No README/AGENTS.md/CLAUDE.md at this commit._\n'
  }
  return sections.join('\n')
}
