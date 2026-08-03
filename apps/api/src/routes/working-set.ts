import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import { readWorkingSet } from '../repositories/working-set.js'

/**
 * The client working set (ARCHITECTURE.md §7).
 *
 * One endpoint, one question: what changed since my cursor. Everything the app displays is derived
 * from the answer on the client, because Postgres cannot sum, sort or search the ciphertext it
 * stores.
 */

export type WorkingSetRoutesOptions = {
  auth: Auth
  context: ContextDependencies
}

const querySchema = z.object({
  /** Omitted on a first load. */
  cursor: z.string().datetime().optional(),
  /** Set when the user extends the range past the default window and wants the older history. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})

export const workingSetRoutes: FastifyPluginAsync<WorkingSetRoutesOptions> = async (
  fastify,
  options,
) => {
  const { auth, context } = options

  fastify.get('/api/working-set', async (request, reply) => {
    const session = await getSession(auth, request.headers)
    if (session === null) {
      return reply.status(401).send({ error: 'Not signed in' })
    }

    const query = querySchema.safeParse(request.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'Invalid cursor or window' })
    }

    try {
      const response = await withHouseholdContext(context, session.user.id, (household) =>
        readWorkingSet(household, {
          cursor: query.data.cursor ?? null,
          from: query.data.from ?? null,
        }),
      )

      /*
       * Never cached by an intermediary. The response is one household's decrypted finances, and a
       * cursor-keyed URL is exactly the shape a proxy would think it could reuse.
       */
      return reply.header('cache-control', 'no-store').send(response)
    } catch (error) {
      if (error instanceof NoHouseholdError) {
        // Signed in but not yet in a household — a real state during onboarding, not an error.
        return reply.status(409).send({ error: 'No household' })
      }
      throw error
    }
  })
}
