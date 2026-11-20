import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function gitCommitAll(repoDir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', message], { cwd: repoDir, stdio: 'pipe' })
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

export function initFixtureRepo(repoDir: string): string {
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'course-kit@test.local'], {
    cwd: repoDir,
    stdio: 'pipe',
  })
  execFileSync('git', ['config', 'user.name', 'course-kit'], { cwd: repoDir, stdio: 'pipe' })
  return repoDir
}

export function writeJavaSampleRepo(repoDir: string): string {
  mkdirSync(repoDir, { recursive: true })
  initFixtureRepo(repoDir)
  writeFileSync(path.join(repoDir, 'README.md'), '# Sample Java app\n', 'utf8')
  writeFileSync(path.join(repoDir, 'AGENTS.md'), '# Agents\nUse tests.\n', 'utf8')
  const main = path.join(repoDir, 'src/main/java/com/example')
  mkdirSync(main, { recursive: true })
  writeFileSync(
    path.join(main, 'App.java'),
    `package com.example;\nimport com.example.util.Helper;\n\npublic class App {\n  public static void main(String[] args) {\n    Helper.run();\n  }\n}\n`,
    'utf8',
  )
  const util = path.join(repoDir, 'src/main/java/com/example/util')
  mkdirSync(util, { recursive: true })
  writeFileSync(
    path.join(util, 'Helper.java'),
    `package com.example.util;\n\npublic class Helper {\n  public static void run() {}\n}\n`,
    'utf8',
  )
  const test = path.join(repoDir, 'src/test/java/com/example')
  mkdirSync(test, { recursive: true })
  writeFileSync(
    path.join(test, 'AppTest.java'),
    `package com.example;\n\npublic class AppTest {\n  void works() {}\n}\n`,
    'utf8',
  )
  return gitCommitAll(repoDir, 'java sample')
}
