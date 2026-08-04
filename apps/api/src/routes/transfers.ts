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
  detectTransfers,
  listProposedTransfers,
  resolveTransfer,
} from '../repositories/transfers.js'

/**
 * Transfer proposals, and the decision on each.
 *
 * Detection is a separate call from listing so it can also be triggered after a sync, and so the
 * screen that shows proposals does not silently create new ones every time it is opened.
 */

export type TransferRoutesOptions = { auth: Auth; deps: ContextDependencies }

const decisionBody = z.object({ decision: z.enum(['confirmed', 'rejected']) })

export const transferRoutes: FastifyPluginAsync<TransferRoutesOptions> = async (fastify, options) => {
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
    return error instanceof NoHouseholdError
      ? reply.status(409).send({ error: 'No household' })
      : null
  }

  fastify.get('/api/transfers/proposed', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const transfers = await withHouseholdContext(deps, user.id, listProposedTransfers)
      return reply.header('cache-control', 'no-store').send({ transfers })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** Re-runs the matcher. Safe to call repeatedly: rejected pairs are never re-proposed. */
  fastify.post('/api/transfers/detect', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const result = await withHouseholdContext(deps, user.id, (context) => detectTransfers(context))
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post<{ Params: { id: string } }>('/api/transfers/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = decisionBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid decision' })
    }

    try {
      await withHouseholdContext(deps, user.id, (context) =>
        resolveTransfer(context, request.params.id, body.data.decision),
      )
      return reply.status(204).send()
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })
}
