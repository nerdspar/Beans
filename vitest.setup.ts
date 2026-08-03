import { existsSync } from 'node:fs'
import { registerPostgresTypeParsers } from './apps/api/src/db/type-parsers.js'

/**
 * Integration tests construct pools directly rather than through `createPool`, so the `date` parser
 * override has to be registered here too. Without it a `date` column comes back as a JS `Date` at
 * local midnight and tests would silently disagree with production about what day it is.
 */
registerPostgresTypeParsers()

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
