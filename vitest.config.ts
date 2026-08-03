import { defineConfig } from 'vitest/config'

/**
 * Test file naming carries meaning here, so that `pnpm test:math` can select the critical money
 * path without a hand-maintained list of directories:
 *
 *   *.math.test.ts         pure money math — parsing, reconstruction, aggregation, transfers.
 *                          No database, no I/O, must stay fast enough to run constantly.
 *   *.integration.test.ts  runs against a real Postgres. Never a mock, never SQLite.
 *   *.test.ts              everything else.
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests share one database and truncate tables, so they must not run concurrently
    // with each other. Unit tests are unaffected.
    fileParallelism: false,
    // Fixtures use fixed dates. A test that depends on the wall clock is a bug — see CLAUDE.md.
    globals: false,
  },
})
