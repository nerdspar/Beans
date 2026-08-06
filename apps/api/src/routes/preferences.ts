import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { MAX_TAB_ORDER_LENGTH } from '@beans/shared'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  readPreferences,
  writePreferences,
  type QueryFn,
} from '../repositories/preferences.js'

/**
 * Per-user interface preferences.
 *
 * Keyed to the **user**, not the household, and stored server-side deliberately: the mobile tab
 * order should follow the person across devices rather than living in one browser. localStorage
 * cannot do that, and syncing it later would mean reconciling two sources of truth.
 *
 * Isolated by `app.current_user_id` rather than `app.current_household` — the one table in the
 * schema whose RLS is user-scoped, which is why this does not go through `withHouseholdContext`.
 */

export type PreferenceRoutesOptions = {
  auth: Auth
  pool: Pool
}

/**
 * A partial update: every field is optional and only what is sent changes.
 *
 * `tabOrder` is nullable *and* optional, and the two mean different things — null clears the
 * preference so a later change to the shipped default reaches this user, undefined leaves it alone.
 * Whole-object semantics would mean the settings screen had to send the tab order back every time
 * it toggled something unrelated, and get it wrong exactly once to wipe it.
 */
const putBody = z.object({
  /**
   * The cap is a payload bound, not a rule about navigation.
   *
   * It was eight, chosen when the setting ordered only the destinations eligible for the bottom bar
   * and six existed. The list now covers every destination — ten, and one more each time a screen is
   * added — so eight silently rejected every save the settings screen made, which reached the user
   * as buttons that flickered and did nothing.
   *
   * The number now lives in `@beans/shared`, because a limit one side enforces and the other has to
   * guess is exactly what that package is for. Nothing downstream trusts the contents anyway:
   * `resolveNavigationOrder` ignores unrecognised keys and de-duplicates the rest, so this only has
   * to stop an unreasonable body rather than police what is in it.
   */
  tabOrder: z.array(z.string().min(1)).max(MAX_TAB_ORDER_LENGTH).nullable().optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  showIncompleteHistory: z.boolean().optional(),
})

export const preferenceRoutes: FastifyPluginAsync<PreferenceRoutesOptions> = async (
  fastify,
  options,
) => {
  const { auth, pool } = options

  /** Runs `fn` with the user-scoped session variable set, inside one transaction. */
  async function asUser<T>(userId: string, fn: (query: QueryFn) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('select set_config($1, $2, true)', ['app.current_user_id', userId])
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

  fastify.get('/api/preferences', async (request, reply) => {
    const session = await getSession(auth, request.headers)
    if (session === null) {
      // Chrome should render for a signed-out user too, showing the defaults.
      return reply.status(401).send({ error: 'Not signed in' })
    }

    const preferences = await asUser(session.user.id, (query) =>
      readPreferences(query, session.user.id),
    )

    return reply.send(preferences)
  })

  fastify.put('/api/preferences', async (request, reply) => {
    const session = await getSession(auth, request.headers)
    if (session === null) {
      return reply.status(401).send({ error: 'Not signed in' })
    }

    const body = putBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid preferences' })
    }

    await asUser(session.user.id, (query) => writePreferences(query, session.user.id, body.data))

    return reply.status(204).send()
  })
}

