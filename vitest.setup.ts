import { existsSync } from 'node:fs'

/**
 * Loads `.env` into `process.env` before tests run, so integration tests can find
 * `TEST_DATABASE_URL`.
 *
 * Node 22 has this built in, so no dotenv dependency. Missing `.env` is not an error — unit tests
 * need nothing from it, and integration tests fail with a clear message of their own.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}
