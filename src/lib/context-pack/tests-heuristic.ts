import path from 'node:path'
import { isProbablyBinaryPath } from './limits.js'

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec)\//i
const TEST_NAME_RE =
  /(^test_.*|.*_test\.\w+|.*\.(test|spec)\.\w+|.*(Test|Tests|IT|Spec)\.(java|kt|scala|groovy|cs))$/

function basenameNoExt(p: string): string {
  const base = path.posix.basename(p)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function isTestPath(p: string): boolean {
  return TEST_DIR_RE.test(p) || TEST_NAME_RE.test(path.posix.basename(p))
}

/** Reduce a test file name to the name of the unit it tests: `FooServiceTest.java` -> `FooService`. */
function testedStem(testPath: string): string {
  let stem = basenameNoExt(testPath)
  stem = stem.replace(/\.(test|spec)$/i, '').replace(/_test$/i, '')
  stem = stem.replace(/^test_/i, '')
  stem = stem.replace(/(Tests|Test|IT|Spec)$/, '')
  return stem
}

/**
 * Heuristic: a test is related if it tests a selected file by name (`Foo` <-> `FooTest`,
 * `foo.test.ts`, `test_foo.py`, `foo_test.go`), or sits in the same directory as a selected file.
 * Selected files that are themselves tests are subjects of nothing but may appear in the result.
 */
export function findRelatedTests(selected: string[], allPaths: string[]): string[] {
  const testPaths = allPaths.filter(
    (p) => !isProbablyBinaryPath(p) && isTestPath(p) && /\.\w+$/.test(p),
  )
  const subjects = selected.filter((p) => !isTestPath(p))
  const stems = new Set(subjects.map(basenameNoExt).map((s) => s.toLowerCase()))
  const dirs = new Set(subjects.map((p) => path.posix.dirname(p)))
  const related = new Set<string>()
  for (const test of testPaths) {
    if (stems.has(testedStem(test).toLowerCase()) || dirs.has(path.posix.dirname(test))) {
      related.add(test)
    }
  }
  return [...related].sort()
}
