import type { Pool } from 'pg'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'

/**
 * Between-test cleanup for integration suites.
 *
 * **Why not `TRUNCATE`.** It is the obvious choice — it ignores RLS, so it can clear tenant tables
 * with no household context. But it creates a fresh relation file for every cascading table and
 * fsyncs each one, and against Postgres on the NAS that measured at **~5 seconds per call**
 * against 3ms for a plain select. Per test, that was the entire runtime of the suite.
 *
 * `DELETE` takes only row locks and needs no fsync storm. The catch is that RLS applies to it, so
 * it cannot clear tables without a household context — which is exactly what cleanup lacks.
 *
 * The way through: every tenant table cascades from `households`, and a household **can** delete
 * itself from inside its own context. So instead of clearing tables globally, we ask each test
 * user to delete their own household and let the foreign keys do the rest.
 *
 * Truncate still has a place — once per file, to clear `auth_user` and anything orphaned. Just not
 * once per test.
 */

/**
 * Deletes the household belonging to each user, cascading away every row that hangs off it.
 *
 * Users with no household are skipped rather than treated as an error: that is the normal state
 * for a test that never created one.
 */
export async function resetHouseholdsFor(
  deps: ContextDependencies,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds) {
    try {
      await withHouseholdContext(deps, userId, async (ctx) => {
        await ctx.client.query('delete from households where id = $1', [ctx.householdId])
      })
    } catch (error) {
      if (!(error instanceof NoHouseholdError)) {
        throw error
      }
    }
    deps.keyCache.delete(userId)
  }

  deps.keyCache.clear()
}

/**
 * Deletes specific households by id, for suites that seed them directly rather than through a user.
 *
 * Sets the household context per id so the delete passes its own RLS policy.
 */
export async function resetHouseholdsById(
  pool: Pool,
  householdIds: readonly string[],
): Promise<void> {
  const client = await pool.connect()
  try {
    for (const householdId of householdIds) {
      await client.query('begin')
      await client.query('select set_config($1, $2, true)', ['app.current_household', householdId])
      await client.query('delete from households where id = $1', [householdId])
      await client.query('commit')
    }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * The heavyweight reset. Run **once per file**, never per test.
 *
 * Clears `auth_user` (no RLS, so a plain delete works) and anything left orphaned by a previous
 * run that crashed mid-test.
 */
export async function resetAll(pool: Pool): Promise<void> {
  await pool.query('truncate households, auth_user restart identity cascade')
}
