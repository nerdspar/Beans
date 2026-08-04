import { parseDecimalToCents } from '@beans/shared'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  AccountError,
  createManualAccount,
  deleteAccount,
  listManagedAccounts,
  recordManualBalance,
  updateAccount,
} from '../repositories/accounts.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'

/**
 * Editing accounts directly.
 *
 * Separate from the connection routes on purpose: a manual account has no connection, and an edit to
 * one synced account should not require re-confirming everything behind its connection.
 */

export type AccountRoutesOptions = {
  auth: Auth
  deps: ContextDependencies
}

const accountType = z.enum([
  'depository',
  'credit',
  'loan',
  'mortgage',
  'investment',
  'other_asset',
  'other_liability',
])

const taxTreatment = z.enum(['taxable', 'traditional', 'roth', 'hsa', 'education', 'none'])
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
/** Money arrives as a decimal string, never a JSON number. */
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/)

const patchBody = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  type: accountType.optional(),
  taxTreatment: taxTreatment.optional(),
  isClosed: z.boolean().optional(),
  closedOn: isoDate.optional(),
  signInverted: z.boolean().optional(),
})

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  institutionName: z.string().trim().min(1).max(120),
  type: accountType,
  balance: money,
  effectiveDate: isoDate,
  taxTreatment: taxTreatment.optional(),
  /** Present when the account being created no longer exists. */
  closedOn: isoDate.optional(),
})

const balanceBody = z.object({ balance: money, effectiveDate: isoDate })

export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (fastify, options) => {
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
    if (error instanceof NoHouseholdError) {
      return reply.status(409).send({ error: 'No household' })
    }
    if (error instanceof AccountError) {
      return reply.status(400).send({ error: error.message })
    }
    return null
  }

  fastify.get('/api/accounts', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const accounts = await withHouseholdContext(deps, user.id, listManagedAccounts)
      return reply.header('cache-control', 'no-store').send({ accounts })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.patch<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = patchBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid account changes' })
    }

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        updateAccount(context, request.params.id, body.data),
      )
      // Reported so the client can say the history was recomputed rather than leaving the user
      // wondering why a chart they were not looking at changed shape.
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post('/api/accounts', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = createBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid account' })
    }

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        createManualAccount(context, {
          name: body.data.name,
          institutionName: body.data.institutionName,
          type: body.data.type,
          balanceCents: parseDecimalToCents(body.data.balance),
          effectiveDate: body.data.effectiveDate,
          ...(body.data.taxTreatment === undefined ? {} : { taxTreatment: body.data.taxTreatment }),
          ...(body.data.closedOn === undefined ? {} : { closedOn: body.data.closedOn }),
        }),
      )
      return reply.status(201).send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /**
   * Removes an account permanently.
   *
   * Irreversible and it takes the transactions with it, so the UI asks first and offers closing —
   * which keeps everything and merely stops it counting — as the default answer.
   */
  fastify.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        deleteAccount(context, request.params.id),
      )
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** A new observation for a manual account. Each becomes a step in its series, never a smooth line. */
  fastify.post<{ Params: { id: string } }>('/api/accounts/:id/balance', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = balanceBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid balance' })
    }

    try {
      await withHouseholdContext(deps, user.id, (context) =>
        recordManualBalance(
          context,
          request.params.id,
          body.data.effectiveDate,
          parseDecimalToCents(body.data.balance),
        ),
      )
      return reply.status(204).send()
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })
}
