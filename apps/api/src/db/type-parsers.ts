import { types } from 'pg'

/**
 * Postgres → JavaScript type parsing overrides.
 *
 * Registered globally on the `pg` module, so this must run before any query. Production does it in
 * `createPool`; tests do it in `vitest.setup.ts`, because they construct pools directly.
 */

/** `date` */
const DATE_OID = 1082

let registered = false

/**
 * Makes `date` columns come back as plain `YYYY-MM-DD` strings.
 *
 * By default node-postgres parses OID 1082 into a JavaScript `Date` at **local midnight**. On a
 * server east of UTC, reading that back with `toISOString()` yields the previous day — a
 * transaction posted on the 3rd silently becomes the 2nd, and no error is raised anywhere.
 *
 * That is the exact bug the money rules exist to prevent: transaction dates are `date`, not
 * `timestamptz`, because a transaction posted on the 3rd is on the 3rd regardless of anyone's
 * timezone (ARCHITECTURE.md §3). Keeping them as strings end to end means no timezone is ever
 * involved, so there is nothing to get wrong.
 *
 * `timestamptz` (OID 1184) keeps the default `Date` parsing — those genuinely are instants, and the
 * conversion is correct for them.
 */
export function registerPostgresTypeParsers(): void {
  if (registered) {
    return
  }
  types.setTypeParser(DATE_OID, (value: string) => value)
  registered = true
}
