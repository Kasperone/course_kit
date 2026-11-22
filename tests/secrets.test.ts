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
const EL_KEY = ['sk', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718'].join('_')
const BEARER_TOKEN = 'abcdef0123456789ABCDEF0123456789xyz'
const KUBE_TOKEN = 'kube-admin-token-0123456789'
const PEM_BEGIN = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'
const PEM_END = '-----END OPENSSH ' + 'PRIVATE KEY-----'

/** The hostile fixture from the PR review, plus a few more formats. */
function writeHostileRepo(dir: string): string {
  initRepo(dir)
  writeFiles(dir, {
    'README.md': `# Target\n\nUse key ${GHP} for the demo.\n\n\`\`\`sh\nexport ELEVENLABS_API_KEY=${EL_KEY}\n\`\`\`\n`,
    'scripts/deploy.sh':
      '#!/bin/sh\nexport DB_PASSWORD=hunter2hunter2\ndocker run -e TOKEN=$TOKEN_FROM_CI app\n',
    Dockerfile:
      'FROM node:22\nENV API_TOKEN=abcd1234efgh5678\nENV DB_PASSWORD=admin1\nENV PORT=8080\n',
    'docs/api.md': `Call it with curl:\n\n\`\`\`sh\ncurl -H "Authorization: Bearer ${BEARER_TOKEN}" https://api.example/v1/items\ncurl -H "Authorization: Bearer \${TOKEN}" https://api.example/v1/items\n\`\`\`\n`,
    'deploy/kubeconfig': `apiVersion: v1\nusers:\n- name: admin\n  user:\n    token: ${KUBE_TOKEN}\n    client-key-data: LS0tLS1CRUdJTi1mYWtl\n`,
    'src/tts.ts': `import { ElevenLabs } from "./client"\nconst c = new ElevenLabs("${EL_KEY}")\n`,
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
    ['.kube/config', 'credentials file'],
    ['home/.kube/config', 'credentials file'],
    ['deploy/kubeconfig', 'credentials file'],
    ['ci/prod.kubeconfig', 'credentials file'],
    ['keys/deploy.ppk', 'key or keystore'],
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
    'docs/kubeconfig-howto.md',
    'src/main/java/com/example/KubeConfig.java',
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

  it('redacts unquoted env-style assignments in any file and sk_ keys', () => {
    const cases: Array<[file: string, line: string, secret: string]> = [
      ['README.md', `export ELEVENLABS_API_KEY=${EL_KEY}`, EL_KEY],
      ['scripts/deploy.sh', 'export DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
      ['Dockerfile', 'ENV API_TOKEN=abcd1234efgh5678', 'abcd1234efgh5678'],
      ['src/tts.ts', `new ElevenLabs("${EL_KEY}")`, EL_KEY],
      ['docs/setup.md', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'],
      ['Makefile', 'GITHUB_TOKEN=plain-token-value-1 make release', 'plain-token-value-1'],
    ]
    for (const [file, line, secret] of cases) {
      const { text, redactions } = redactSecrets(line, file)
      expect(text, file).not.toContain(secret)
      expect(text, file).toContain(REDACTED)
      expect(redactions, file).toHaveLength(1)
    }
    expect(redactSecrets(`export ELEVENLABS_API_KEY=${EL_KEY}`, 'README.md').text).toBe(
      `export ELEVENLABS_API_KEY=${REDACTED}`,
    )
    // References, short values and names that are not secret-looking are left alone.
    const keep = [
      'export API_KEY=$API_KEY',
      'export API_KEY=${API_KEY}',
      'TOKEN=$(cat /run/secrets/token)',
      'MAX_TOKENS=1000',
      'ENV NODE_ENV=production',
      'PASSWORD_MIN_LENGTH=12',
      'PORT=8080',
      `API_KEY=${REDACTED}`,
    ]
    for (const line of keep) expect(redactSecrets(line, 'README.md').text, line).toBe(line)
  })

  it('redacts bearer tokens but keeps the prefix and templates', () => {
    const line = `curl -H "Authorization: Bearer ${BEARER_TOKEN}" https://api.example/v1`
    const { text, redactions } = redactSecrets(line, 'README.md')
    expect(text).toBe(`curl -H "Authorization: Bearer ${REDACTED}" https://api.example/v1`)
    expect(redactions).toEqual([{ line: 1, kind: 'bearer-token' }])
    const padded = redactSecrets(`Authorization: Bearer ${BEARER_TOKEN}==`, 'x.txt').text
    expect(padded).toBe(`Authorization: Bearer ${REDACTED}`)
    const keep = [
      'curl -H "Authorization: Bearer ${TOKEN}" https://api.example',
      'Authorization: Bearer $ACCESS_TOKEN',
      'Authorization: Bearer <your-token-here>',
      'the Bearer scheme is described in RFC 6750',
      'Bearer short',
    ]
    for (const l of keep) expect(redactSecrets(l, 'README.md').text, l).toBe(l)
  })

  it('redacts short unquoted values too, but not numbers or booleans', () => {
    const redacted: Array<[line: string, secret: string]> = [
      ['ENV DB_PASSWORD=admin1', 'admin1'],
      ['export API_KEY=abc1234', 'abc1234'],
      ['SECRET=s3cr', 's3cr'],
    ]
    for (const [line, secret] of redacted) {
      const { text, redactions } = redactSecrets(line, 'Dockerfile')
      expect(text, line).not.toContain(secret)
      expect(redactions, line).toHaveLength(1)
    }
    for (const line of [
      'MAX_TOKENS=1000',
      'TOKEN_TTL=3600',
      'PASSWORD_REQUIRED=true',
      'SECRET_ROTATION_ENABLED=FALSE',
      'API_KEY=abc',
    ]) {
      expect(redactSecrets(line, 'README.md').text, line).toBe(line)
    }
  })

  it('redacts kubeconfig-style keys in YAML files', () => {
    const yml = [
      'users:',
      '- user:',
      '    token: abc',
      '    client-key-data: LS0tLS1CRUdJTi1mYWtl',
    ].join('\n')
    const { text } = redactSecrets(yml, 'cluster/admin.yaml')
    expect(text).not.toContain('LS0tLS1')
    expect(text).toContain(`token: ${REDACTED}`)
    expect(text).toContain(`client-key-data: ${REDACTED}`)
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
      globs: [
        'README.md',
        'src/**',
        '.env.example',
        'scripts/**',
        'Dockerfile',
        'docs/**',
        'deploy/**',
      ],
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
      EL_KEY,
      'abcd1234efgh5678',
      'admin1',
      BEARER_TOKEN,
      KUBE_TOKEN,
      'LS0tLS1CRUdJTi1mYWtl',
    ]) {
      expect(md, secret).not.toContain(secret)
      expect(json, secret).not.toContain(secret)
    }

    const sensitive = meta.skipped.filter((s) => s.reason === 'sensitive').map((s) => s.path)
    expect(sensitive.sort()).toEqual(
      [
        '.env',
        'deploy/kubeconfig',
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
        'scripts/deploy.sh',
        'Dockerfile',
        'docs/api.md',
        'src/tts.ts',
      ]),
    )
    // References and non-secrets stay readable.
    expect(md).toContain('TOKEN=$TOKEN_FROM_CI')
    expect(md).toContain('ENV PORT=8080')
    expect(md).toContain('Authorization: Bearer ${TOKEN}')
    expect(meta.warnings.join('\n')).toMatch(/7 sensitive file\(s\) were not embedded/)
    expect(meta.warnings.join('\n')).toMatch(/Redacted \d+ secret-looking value/)
    expect(md).toContain('| sensitive | 7 |')
    expect(md).toContain('request.getPassword()')
    expect(md).toContain('server.port=8080')
  })
})
