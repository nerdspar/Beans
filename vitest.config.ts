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

    /**
     * Integration tests share one database and reset it with `TRUNCATE`, which takes an
     * ACCESS EXCLUSIVE lock. Run two such files at once and they block each other until the hook
     * times out — which presents as every integration file failing at once, with no hint that
     * concurrency is the cause.
     *
     * `fileParallelism: false` alone was not sufficient; the worker pool also has to be pinned to
     * one. Unit tests are fast enough that losing parallelism costs little.
     */
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,

    /**
     * The database lives on the NAS rather than localhost, so every query is a LAN round trip and
     * setup hooks that truncate a dozen cascading tables are not instant. The default 10s is tight
     * enough that a slow moment reads as a failure.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Fixtures use fixed dates. A test that depends on the wall clock is a bug — see CLAUDE.md.
    globals: false,
  },
})
