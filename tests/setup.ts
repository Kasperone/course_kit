// Isolate tests from the developer's git configuration (signing, hooks, default branch, ...).
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = 'course-kit'
process.env.GIT_AUTHOR_EMAIL = 'course-kit@test.local'
process.env.GIT_COMMITTER_NAME = 'course-kit'
process.env.GIT_COMMITTER_EMAIL = 'course-kit@test.local'
