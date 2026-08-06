import { MAX_TAB_ORDER_LENGTH } from '@beans/shared'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readPreferences, writePreferences, type QueryFn } from './preferences.js'
import { resetAll } from '../test-support/reset-database.js'

/**
 * Saving a navigation order, against a real Postgres.
 *
 * These exist because this never worked and nothing noticed. `tab_order` is `jsonb`, the route
 * passed a JavaScript array, and node-pg serialized it as a Postgres array literal — `{a,b,c}` —
 * which json rejects. Every save threw, at every length, from the first one.
 *
 * It was invisible from both ends: the route returned 500, the client did not check the response,
 * and its optimistic update rolled back on the next refetch. On screen that is a row that moves and
 * moves back, which reads as a dead button rather than a failed write.
 *
 * So the round trip is the test, and it has to run against Postgres. A mock would have accepted the
 * array happily — the whole defect lives in what the driver and the column do with each other.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const USER = 'prefs-user-fixed-id'

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('user preferences', () => {
  let pool: Pool

  /** The route's own wrapper: one transaction with the user-scoped RLS variable set. */
  async function asUser<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('select set_config($1, $2, true)', ['app.current_user_id', USER])
      const result = await fn((text, values) => client.query(text, values))
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    await resetAll(pool)
    await pool.query(
      'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
      [USER, 'Prefs User', 'prefs@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    /*
     * Through `asUser`, not the bare pool.
     *
     * `user_preferences` is RLS-protected on `app.current_user_id`, so a delete without that
     * variable set matches no rows and reports success — the row survived and the next test read
     * the previous one's order. Worth keeping as a note: this is the isolation working, and it is
     * equally capable of making a test quietly meaningless.
     */
    await asUser((query) => query('delete from user_preferences where user_id = $1', [USER]))
  })

  it('stores a navigation order and reads it back as an array', async () => {
    const order = ['portfolio', 'net-worth', 'rules', 'transactions']

    await asUser((query) => writePreferences(query, USER, { tabOrder: order }))
    const stored = await asUser((query) => readPreferences(query, USER))

    // `toEqual` on the array, not a JSON string: a jsonb column that received a serialized array
    // hands back a real one, and anything else means the round trip changed the shape.
    expect(stored.tabOrder).toEqual(order)
  })

  it('stores an order as long as the API will accept', async () => {
    // The failure was not length-dependent, but the cap and the column are the two limits a longer
    // order has to clear, and only one of them was ever the visible problem.
    const order = Array.from({ length: MAX_TAB_ORDER_LENGTH }, (_, index) => `key-${index}`)

    await asUser((query) => writePreferences(query, USER, { tabOrder: order }))
    const stored = await asUser((query) => readPreferences(query, USER))

    expect(stored.tabOrder).toEqual(order)
  })

  it('defaults to no order for a user who has never saved one', async () => {
    const stored = await asUser((query) => readPreferences(query, USER))
    expect(stored.tabOrder).toBeNull()
    expect(stored.showIncompleteHistory).toBe(true)
  })

  it('clears the order when sent null, rather than storing a JSON null', async () => {
    await asUser((query) => writePreferences(query, USER, { tabOrder: ['rules', 'portfolio'] }))
    await asUser((query) => writePreferences(query, USER, { tabOrder: null }))

    const stored = await asUser((query) => readPreferences(query, USER))
    // Null, not `[]` and not the string "null" — clearing means "no preference", so a later change
    // to the shipped default reaches this user.
    expect(stored.tabOrder).toBeNull()
  })

  it('leaves the order alone when a patch does not mention it', async () => {
    const order = ['rules', 'portfolio']
    await asUser((query) => writePreferences(query, USER, { tabOrder: order }))

    // The reason `tabOrder` is nullable *and* optional. Toggling something unrelated must not wipe
    // a navigation order the user spent time on.
    await asUser((query) => writePreferences(query, USER, { showIncompleteHistory: false }))

    const stored = await asUser((query) => readPreferences(query, USER))
    expect(stored.tabOrder).toEqual(order)
    expect(stored.showIncompleteHistory).toBe(false)
  })
})
