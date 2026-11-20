import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export function defaultOutDir(targetRepo: string, cwd: string = process.cwd()): string {
  const base = path.basename(targetRepo)
  const safe = base.replace(/[^\w.-]+/g, '-') || 'repo'
  return path.join(cwd, `${safe}-course`)
}

export function packageRoot(): string {
  return path.resolve(moduleDir, '..', '..')
}

export function templatesDir(): string {
  return path.join(packageRoot(), 'templates', 'workspace')
}
