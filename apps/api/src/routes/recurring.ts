import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import {
  RecurringAccountNotFoundError,
  clearRecurringDecision,
  setRecurringDecision,
} from '../repositories/recurring-decisions.js'

/**
 * Overrides for detected recurring series (ARCHITECTURE.md §20).
 *
 * There is no endpoint that lists series: detection runs in the browser over the working set, and
 * the decisions reach the client inside it. These two only write.
 */

export type RecurringRoutesOptions = { auth: Auth; deps: ContextDependencies }

const decisionBody = z.object({
  // Bounded so a request cannot ask the server to encrypt and store something enormous.
  merchantKey: z.string().min(1).max(200),
  decision: z.enum(['subscription', 'bill', 'ignored']),
  accountId: z.string().uuid(),
})

export const recurringRoutes: FastifyPluginAsync<RecurringRoutesOptions> = async (
  fastify,
  options,
) => {
  const { auth, deps } = options

  async function requireUser(request: { headers: unknown }, reply: FastifyReply) {
    const session = await getSession(auth, request.headers as Parameters<typeof getSession>[1])
    if (session === null) {
      await reply.status(401).send({ error: 'Not signed in' })
      return null
    }
    return { id: session.user.id }
  }

  function handleError(error: unknown, reply: FastifyReply): FastifyReply | null {
    if (error instanceof NoHouseholdError) return reply.status(409).send({ error: 'No household' })
    if (error instanceof RecurringAccountNotFoundError) {
      return reply.status(404).send({ error: 'Account not found' })
    }
    return null
  }

  fastify.put('/api/recurring-decisions', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = decisionBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid decision' })
    }

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        setRecurringDecision(context, body.data),
      )
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/api/recurring-decisions/:id',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      try {
        const removed = await withHouseholdContext(deps, user.id, (context) =>
          clearRecurringDecision(context, request.params.id),
        )
        return removed ? reply.status(204).send() : reply.status(404).send({ error: 'Not found' })
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )
}
