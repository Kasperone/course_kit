import { isProbablyBinaryPath } from './limits.js'
import { inlineCode } from './markdown.js'

export function buildTreeSummary(allPaths: string[], maxPathsListed: number): string {
  const filtered = allPaths.filter((p) => !isProbablyBinaryPath(p))
  const byTop = new Map<string, number>()
  for (const p of filtered) {
    const top = p.includes('/') ? `${p.split('/')[0]!}/` : '(root)'
    byTop.set(top, (byTop.get(top) ?? 0) + 1)
  }
  const lines: string[] = [
    `Tracked files at pinned commit (text-ish): **${filtered.length}** total.`,
    '',
    '| Prefix | Files |',
    '|--------|------:|',
  ]
  const sorted = [...byTop.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [prefix, count] of sorted.slice(0, 40)) {
    lines.push(`| ${inlineCode(prefix).replace(/\|/g, '\\|')} | ${count} |`)
  }
  if (sorted.length > 40) {
    lines.push(`| … | ${sorted.length - 40} more prefixes |`)
  }
  lines.push('', 'Sample paths (capped):', '')
  for (const p of filtered.slice(0, maxPathsListed)) {
    lines.push(`- ${inlineCode(p)}`)
  }
  if (filtered.length > maxPathsListed) {
    lines.push(`- … and ${filtered.length - maxPathsListed} more`)
  }
  return lines.join('\n')
}
