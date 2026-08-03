import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit 0.31.10.
 *
 * Note that orm.drizzle.team documents the v1 release candidate, which differs in several places
 * from the stable line we are pinned to. Check the shipped types before copying a doc snippet.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  verbose: true,
  strict: true,
})
