import { PACK_LIMITS } from './limits.js'
import { readTextAtCommit } from '../git-commit.js'

const DOC_CANDIDATES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'readme.md']

export function buildDocExcerpts(repo: string, commit: string): string {
  const sections: string[] = []
  for (const name of DOC_CANDIDATES) {
    const text = readTextAtCommit(repo, commit, name)
    if (!text) continue
    const lines = text.split('\n').slice(0, PACK_LIMITS.maxDocExcerptLines)
    sections.push(
      `### ${name}`,
      '',
      '```markdown',
      ...lines,
      lines.length < text.split('\n').length ? '…' : '',
      '```',
      '',
    )
  }
  if (sections.length === 0) {
    return '_No README/AGENTS.md/CLAUDE.md at this commit._\n'
  }
  return sections.join('\n')
}
