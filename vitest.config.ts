import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // At most 4 test workers (memory-bound lab machine; CI runners have 4 cores anyway).
    maxWorkers: 4,
    minWorkers: 1,
  },
})
