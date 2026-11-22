import { minimatch } from 'minimatch'

/**
 * Files that are never embedded in a context pack, whatever the lesson selects. Packs go to LLMs,
 * may be committed and will ground the Q&A chat, so committed secrets in a target repo must not
 * spread further. Spring `application*.properties|yml` files are embedded (they are useful lesson
 * material) but always pass through value redaction; profile files that conventionally hold
 * real credentials are denied outright.
 */
const DENY: Array<[pattern: string, reason: string]> = [
  ['**/.env', 'environment file'],
  ['**/.env.*', 'environment file'],
  ['**/*.env', 'environment file'],
  ['**/.envrc', 'environment file'],
  ['**/id_{rsa,dsa,ecdsa,ed25519}{,.pub}', 'SSH key'],
  ['**/*.{pem,key,ppk,p8,p12,pfx,jks,keystore,truststore,gpg,pgp,kdbx,ovpn}', 'key or keystore'],
  [
    '**/{.npmrc,.pypirc,.netrc,_netrc,.git-credentials,.htpasswd,.pgpass,.dockercfg}',
    'credentials file',
  ],
  ['**/.docker/config.json', 'credentials file'],
  // kubeconfigs hold cluster tokens and client keys
  ['**/{.kube/config,kubeconfig,*.kubeconfig}', 'credentials file'],
  ['**/{credentials,credentials.*,*credentials*.json,*-credentials.*}', 'credentials file'],
  ['**/{secret,secrets}.*', 'secrets file'],
  ['**/{secret,secrets}/**', 'secrets directory'],
  ['**/*.{tfstate,tfvars}', 'Terraform state/vars'],
  ['**/*.tfstate.*', 'Terraform state/vars'],
  ['**/service-account*.json', 'cloud service account key'],
  [
    '**/application-{prod,production,secret,secrets,local}*.{properties,yml,yaml}',
    'Spring profile with credentials',
  ],
]

/** Template/example env files are documentation, not secrets. */
const ALLOW = ['**/.env.{example,sample,template,dist}', '**/*.env.{example,sample,template}']

const OPTS = { dot: true, nocase: true }

/** Reason a path must not be embedded, or null if it may be. */
export function sensitiveReason(filePath: string): string | null {
  if (ALLOW.some((p) => minimatch(filePath, p, OPTS))) return null
  for (const [pattern, reason] of DENY) {
    if (minimatch(filePath, pattern, OPTS)) return reason
  }
  return null
}
