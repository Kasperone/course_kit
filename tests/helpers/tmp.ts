import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const created: string[] = []

afterAll(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Create a temp directory that is removed after the current test file finishes. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `course-kit-${prefix}-`))
  created.push(dir)
  return dir
}
