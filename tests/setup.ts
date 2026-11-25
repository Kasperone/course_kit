// Isolate tests from the developer's git configuration (signing, hooks, default branch, ...).
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = 'course-kit'
process.env.GIT_AUTHOR_EMAIL = 'course-kit@test.local'
process.env.GIT_COMMITTER_NAME = 'course-kit'
process.env.GIT_COMMITTER_EMAIL = 'course-kit@test.local'

// No live network calls from tests (no provider APIs, no downloads): only loopback URLs may be
// fetched. Tests that need a remote service use a mocked fetch or a local fake server.
const realFetch = globalThis.fetch
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return Promise.reject(new Error(`tests may not fetch ${url.origin} (no live network calls)`))
  }
  return realFetch(input, init)
}) as typeof fetch
