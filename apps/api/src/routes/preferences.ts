import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'

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

const putBody = z.object({
  /** Null means "no preference", so a later change to the shipped default reaches this user. */
  tabOrder: z.array(z.string().min(1)).max(8).nullable(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
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

    const preferences = await asUser(session.user.id, async (query) => {
      const result = await query<{ tab_order: string[] | null; theme: string }>(
        'select tab_order, theme from user_preferences where user_id = $1',
        [session.user.id],
      )
      return result.rows[0]
    })

    return reply.send({
      tabOrder: preferences?.tab_order ?? null,
      theme: preferences?.theme ?? 'system',
    })
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

    await asUser(session.user.id, async (query) => {
      /**
       * Upsert rather than update: a user has no preferences row until they change something, and
       * creating one on signup would mean every code path that creates a user has to remember.
       *
       * The stored keys are not validated against the destination registry on purpose — that list
       * lives in the frontend and changes with it. Unknown keys are dropped when the preference is
       * resolved, so a stale one degrades to the default rather than breaking navigation.
       */
      await query(
        `insert into user_preferences (user_id, tab_order, theme)
         values ($1, $2, coalesce($3, 'system'))
         on conflict (user_id) do update
           set tab_order = excluded.tab_order,
               theme = coalesce($3, user_preferences.theme)`,
        [session.user.id, body.data.tabOrder, body.data.theme ?? null],
      )
    })

    return reply.status(204).send()
  })
}

type QueryFn = <T extends Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>
