import path from 'node:path'
import { isProbablyBinaryPath } from './limits.js'

function basenameNoExt(p: string): string {
  const base = path.posix.basename(p)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function isTestPath(p: string): boolean {
  const lower = p.toLowerCase()
  if (lower.includes('/test/') || lower.includes('/tests/')) return true
  if (lower.includes('src/test/')) return true
  const base = path.posix.basename(p)
  return (
    base.endsWith('Test.java') ||
    base.endsWith('Tests.java') ||
    base.endsWith('.test.ts') ||
    base.endsWith('.spec.ts') ||
    base.endsWith('_test.go') ||
    base.startsWith('test_')
  )
}

export function findRelatedTests(selected: string[], allPaths: string[]): string[] {
  const testPaths = allPaths.filter((p) => !isProbablyBinaryPath(p) && isTestPath(p))
  const related = new Set<string>()

  for (const file of selected) {
    const stem = basenameNoExt(file)
    const dir = path.posix.dirname(file)
    for (const test of testPaths) {
      const testBase = path.posix.basename(test)
      if (
        testBase.includes(stem) ||
        test.includes(`/${stem}Test`) ||
        test.includes(`/${stem}Tests`) ||
        test.includes(`Test${stem}`)
      ) {
        related.add(test)
        continue
      }
      if (path.posix.dirname(test) === dir && testBase.toLowerCase().includes('test')) {
        related.add(test)
      }
    }
  }

  return [...related].sort().slice(0, 20)
}
