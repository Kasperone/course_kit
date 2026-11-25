import path from 'node:path'
import { runInit } from '../../src/commands/init.js'
import { commitAll, git, initRepo, writeFiles } from './git.js'
import { makeTempDir } from './tmp.js'

export function writeJavaSampleRepo(repoDir: string): string {
  initRepo(repoDir)
  writeFiles(repoDir, {
    'README.md': '# Sample Java app\n',
    'AGENTS.md': '# Agents\nUse tests.\n',
    'src/main/java/com/example/App.java': `package com.example;\nimport com.example.util.Helper;\n\npublic class App {\n  public static void main(String[] args) {\n    Helper.run();\n  }\n}\n`,
    'src/main/java/com/example/util/Helper.java': `package com.example.util;\n\npublic class Helper {\n  public static void run() {}\n}\n`,
    'src/test/java/com/example/AppTest.java': `package com.example;\n\npublic class AppTest {\n  void works() {}\n}\n`,
  })
  return commitAll(repoDir, 'java sample')
}

export type Fixture = { root: string; repoDir: string; workspace: string; pinned: string }

/** Temp target repo built by `populate` plus a fresh course workspace pinned to it. */
export async function makeWorkspace(
  populate: (repoDir: string) => string = writeJavaSampleRepo,
  opts: { languages?: string[]; submodule?: boolean } = {},
): Promise<Fixture> {
  const root = makeTempDir('ws')
  const repoDir = path.join(root, 'target')
  const pinned = populate(repoDir)
  if (opts.submodule) {
    // --submodule needs a network origin; a tracking ref marks the pinned commit as pushed.
    git(repoDir, ['remote', 'add', 'origin', 'https://git.example/acme/app.git'])
    git(repoDir, ['update-ref', 'refs/remotes/origin/main', pinned])
  }
  const workspace = path.join(root, 'course')
  await runInit({
    targetRepo: repoDir,
    outDir: workspace,
    languages: opts.languages ?? ['pl', 'en'],
    submodule: opts.submodule ?? false,
    cwd: root,
  })
  return { root, repoDir, workspace, pinned }
}
