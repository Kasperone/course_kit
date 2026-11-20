import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function defaultOutDir(targetRepo: string, cwd: string = process.cwd()): string {
  const base = path.basename(targetRepo)
  const safe = base.replace(/[^\w.-]+/g, '-') || 'repo'
  return path.join(cwd, `${safe}-course`)
}

export function packageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  if (path.basename(moduleDir) === 'dist') {
    return path.resolve(moduleDir, '..')
  }
  return path.resolve(moduleDir, '..', '..')
}

export function templatesDir(): string {
  return path.join(packageRoot(), 'templates', 'workspace')
}
