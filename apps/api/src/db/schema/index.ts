/**
 * The schema barrel.
 *
 * Both drizzle-kit and the Better Auth adapter read from here, so every table must be re-exported.
 *
 * Files are ordered so the foreign-key graph stays acyclic: `categories` and `imports` are defined
 * without references to `accounts`, which lets `accounts` point at both, and the tables that depend
 * on everything (`categorization`, `import-rows`) come last.
 */
export * from './enums.js'
export * from './auth.js'
export * from './tenancy.js'
export * from './categories.js'
export * from './imports.js'
export * from './connections.js'
export * from './accounts.js'
export * from './categorization.js'
export * from './import-rows.js'
export * from './retirement.js'
export * from './recurring.js'
export * from './reference.js'
