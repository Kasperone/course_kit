import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runContext } from '../src/commands/context.js'
import { REDACTED, redactSecrets } from '../src/lib/context-pack/redact.js'
import { sensitiveReason } from '../src/lib/context-pack/sensitive.js'
import { readLessonJson, writeLessonJson } from '../src/lib/lesson.js'
import { makeWorkspace } from './helpers/fixture-repo.js'
import { commitAll, initRepo, writeFiles } from './helpers/git.js'

// Fake secrets, assembled at runtime so the repo itself never contains token-shaped strings.
const SK = ['sk', 'live', 'SECRET123'].join('-')
const GHP = 'ghp_' + 'a'.repeat(36)
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const PEM_BEGIN = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'
const PEM_END = '-----END OPENSSH ' + 'PRIVATE KEY-----'

/** The hostile fixture from the PR review, plus a few more formats. */
function writeHostileRepo(dir: string): string {
  initRepo(dir)
  writeFiles(dir, {
    'README.md': `# Target\n\nUse key ${GHP} for the demo.\n`,
    'src/.env': `API_KEY=${SK}\nDB_PASSWORD=hunter2\n`,
    '.env': 'ROOT_SECRET=topsecret\n',
    '.env.example': 'API_KEY=\nDB_PASSWORD=changeme\n',
    'src/id_ed25519': `${PEM_BEGIN}\nb3BlbnNzaC1rZXktdjEAAAAA\n${PEM_END}\n`,
    'src/server.pem': 'cert\n',
    'src/main/resources/application.properties':
      'spring.datasource.url=jdbc:postgresql://db:5432/app\nspring.datasource.password=SUPERSECRET\nserver.port=8080\n',
    'src/main/resources/application.yml':
      'spring:\n  datasource:\n    username: app\n    password: ${DB_PASSWORD:devpass}\n    url: postgres://app:urlpass@db/app\n  security:\n    jwt-secret: ${JWT_SECRET}\n',
    'src/main/resources/application-prod.yml': 'spring.datasource.password: prodpass\n',
    'src/main/java/com/example/Config.java': `package com.example;\nclass Config {\n  String apiKey = "${SK}";\n  String password = "hunter2hunter2";\n  String aws = "${AWS}";\n  String user = request.getPassword();\n}\n`,
    'src/main/java/com/example/KeyHolder.java': `package com.example;\nclass KeyHolder {\n  static final String KEY = """\n${PEM_BEGIN}\nAAAAB3NzaC1yc2E\n${PEM_END}\n""";\n}\n`,
    'src/config/settings.json': '{\n  "clientSecret": "s3cr3t-value",\n  "timeout": 30\n}\n',
    'src/secrets/db.txt': 'admin:admin\n',
    'src/test/java/com/example/ConfigTest.java':
      'package com.example;\nclass ConfigTest { String token = "test-token-value"; }\n',
  })
  return commitAll(dir, 'hostile')
}

describe('sensitive path denylist', () => {
  it.each([
    ['.env', 'environment file'],
    ['src/.env', 'environment file'],
    ['config/.env.production', 'environment file'],
    ['src/id_ed25519', 'SSH key'],
    ['home/.ssh/id_rsa.pub', 'SSH key'],
    ['certs/server.pem', 'key or keystore'],
    ['src/main/resources/keystore.jks', 'key or keystore'],
    ['deploy/tls.KEY', 'key or keystore'],
    ['.npmrc', 'credentials file'],
    ['gcp/credentials.json', 'credentials file'],
    ['config/secrets.yml', 'secrets file'],
    ['infra/secrets/db.txt', 'secrets directory'],
    ['infra/terraform.tfstate', 'Terraform state/vars'],
    ['src/main/resources/application-prod.yml', 'Spring profile with credentials'],
  ])('denies %s', (p, reason) => {
    expect(sensitiveReason(p)).toBe(reason)
  })

  it.each([
    '.env.example',
    'backend/.env.sample',
    'src/main/resources/application.yml',
    'src/main/resources/application-test.yml',
    'src/main/java/com/example/KeyService.java',
    'docs/environment.md',
    'README.md',
  ])('allows %s', (p) => {
    expect(sensitiveReason(p)).toBeNull()
  })
})

describe('secret redaction', () => {
  it('redacts token formats, URL passwords and literal assignments in code', () => {
    const src = [
      `const a = "${SK}"`,
      `token ${GHP} here`,
      `aws ${AWS}`,
      'url = "postgres://app:urlpass@db/app"',
      'String password = "hunter2hunter2";',
      'String user = request.getPassword();',
      'int tokens = 5;',
    ].join('\n')
    const { text, redactions } = redactSecrets(src, 'src/A.java')
    expect(text).not.toContain(SK)
    expect(text).not.toContain(GHP)
    expect(text).not.toContain(AWS)
    expect(text).not.toContain('urlpass')
    expect(text).not.toContain('hunter2hunter2')
    expect(text).toContain('postgres://app:‹redacted›@db/app')
    expect(text).toContain('request.getPassword()')
    expect(text).toContain('int tokens = 5;')
    expect(text.split('\n')).toHaveLength(7)
    expect(redactions.map((r) => r.line)).toEqual([1, 2, 3, 4, 5])
  })

  it('redacts config values but keeps placeholders, booleans and structure', () => {
    const yml = [
      'spring:',
      '  datasource:',
      '    password: ${DB_PASSWORD:devpass}',
      '    username: app',
      '  jwt-secret: ${JWT_SECRET}',
      '  api-key: "abc123"',
      '  token-enabled: true',
      'secret:',
    ].join('\n')
    const { text } = redactSecrets(yml, 'application.yml')
    expect(text.split('\n')).toEqual([
      'spring:',
      '  datasource:',
      `    password: \${DB_PASSWORD:${REDACTED}}`,
      '    username: app',
      '  jwt-secret: ${JWT_SECRET}',
      `  api-key: "${REDACTED}"`,
      '  token-enabled: true',
      'secret:',
    ])
    const props = redactSecrets('a.password=SUPERSECRET\nserver.port=8080\n', 'app.properties')
    expect(props.text).toBe(`a.password=${REDACTED}\nserver.port=8080\n`)
    const json = redactSecrets('{ "clientSecret": "s3cr3t-value", "timeout": 30 }', 'x.json')
    expect(json.text).not.toContain('s3cr3t-value')
  })

  it('redacts private key blocks but keeps line numbers', () => {
    const src = `a\n${PEM_BEGIN}\nAAAA\nBBBB\n${PEM_END}\nb`
    const { text } = redactSecrets(src, 'x.txt')
    expect(text.split('\n')).toEqual(['a', PEM_BEGIN, REDACTED, REDACTED, PEM_END, 'b'])
  })
})

describe('context packs and secrets (review fixture)', () => {
  it('never embeds denylisted files and redacts secrets in everything else', async () => {
    const fx = await makeWorkspace(writeHostileRepo)
    const lessonRoot = path.join(fx.workspace, 'lessons', '01-placeholder')
    // Default globs plus explicit requests for secret files: the denylist still wins.
    writeLessonJson(lessonRoot, {
      ...readLessonJson(lessonRoot),
      files: ['.env', 'src/id_ed25519'],
      globs: ['README.md', 'src/**', '.env.example'],
    })
    const meta = await runContext({ lessonId: '01-placeholder', json: true, cwd: fx.workspace })
    const md = readFileSync(path.join(lessonRoot, 'context-pack.md'), 'utf8')
    const json = readFileSync(path.join(lessonRoot, 'context-pack.json'), 'utf8')

    for (const secret of [
      SK,
      GHP,
      AWS,
      'hunter2',
      'topsecret',
      'SUPERSECRET',
      'devpass',
      'urlpass',
      'prodpass',
      's3cr3t-value',
      'admin:admin',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      'AAAAB3NzaC1yc2E',
      'test-token-value',
    ]) {
      expect(md, secret).not.toContain(secret)
      expect(json, secret).not.toContain(secret)
    }

    const sensitive = meta.skipped.filter((s) => s.reason === 'sensitive').map((s) => s.path)
    expect(sensitive.sort()).toEqual(
      [
        '.env',
        'src/.env',
        'src/id_ed25519',
        'src/main/resources/application-prod.yml',
        'src/secrets/db.txt',
        'src/server.pem',
      ].sort(),
    )
    expect(meta.selectedFiles).toContain('.env.example')
    expect(meta.selectedFiles).toContain('src/main/resources/application.yml')
    expect(meta.redactions.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        'README.md',
        'src/main/java/com/example/Config.java',
        'src/main/java/com/example/KeyHolder.java',
        'src/main/resources/application.properties',
        'src/main/resources/application.yml',
        'src/config/settings.json',
        'src/test/java/com/example/ConfigTest.java',
      ]),
    )
    expect(meta.warnings.join('\n')).toMatch(/6 sensitive file\(s\) were not embedded/)
    expect(meta.warnings.join('\n')).toMatch(/Redacted \d+ secret-looking value/)
    expect(md).toContain('| sensitive | 6 |')
    expect(md).toContain('request.getPassword()')
    expect(md).toContain('server.port=8080')
  })
})
