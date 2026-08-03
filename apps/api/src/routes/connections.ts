import { centsToDecimalString } from '@beans/shared'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  ConnectionError,
  confirmAccounts,
  createConnection,
  discoverAccounts,
  reconnect,
} from '../repositories/connections.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import { SimplefinError } from '../simplefin/client.js'
import { runSync } from '../sync/sync-service.js'

/**
 * SimpleFIN connection endpoints.
 *
 * The setup token arrives here and is claimed immediately; **the resulting access URL is never
 * returned to the client, not even partially.** It carries basic auth for the user's entire Bridge
 * account, so it exists only encrypted at rest and decrypted inside a sync.
 */

export type ConnectionRoutesOptions = {
  auth: Auth
  deps: ContextDependencies
  fetcher?: typeof globalThis.fetch
}

const setupTokenBody = z.object({
  setupToken: z.string().trim().min(1),
})

const confirmBody = z.object({
  accounts: z
    .array(
      z.object({
        simplefinAccountId: z.string().min(1),
        type: z.enum([
          'depository',
          'credit',
          'loan',
          'mortgage',
          'investment',
          'other_asset',
          'other_liability',
        ]),
        signInverted: z.boolean(),
        displayName: z.string().trim().min(1).max(120).optional(),
        taxTreatment: z
          .enum(['taxable', 'traditional', 'roth', 'hsa', 'education', 'none'])
          .optional(),
        include: z.boolean(),
      }),
    )
    .min(1),
})

export const connectionRoutes: FastifyPluginAsync<ConnectionRoutesOptions> = async (
  fastify,
  options,
) => {
  const { auth, deps, fetcher = globalThis.fetch } = options

  async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: string } | null> {
    const session = await getSession(auth, request.headers)
    if (session === null) {
      await reply.status(401).send({ error: 'Not signed in' })
      return null
    }
    return { id: session.user.id }
  }

  /** Translates repository and provider errors into responses without leaking internals. */
  function handleError(error: unknown, reply: FastifyReply): FastifyReply | null {
    if (error instanceof NoHouseholdError) {
      return reply.status(404).send({ error: 'You do not belong to a household yet' })
    }
    if (error instanceof SimplefinError) {
      return reply.status(400).send({ error: error.message })
    }
    if (error instanceof ConnectionError) {
      return reply.status(400).send({ error: error.message })
    }
    return null
  }

  /**
   * Claims a setup token and returns the discovered accounts for confirmation.
   *
   * Discovery is deliberately part of the same call: a connection with no confirmed accounts is a
   * dead end, and making the client remember to follow up would leave those lying around.
   */
  fastify.post('/api/connections', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = setupTokenBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'A SimpleFIN setup token is required' })
    }

    try {
      const result = await withHouseholdContext(deps, user.id, async (context) => {
        const { connectionId } = await createConnection(context, body.data.setupToken, fetcher)
        const discovery = await discoverAccounts(context, connectionId, fetcher)
        return { connectionId, discovery }
      })

      return reply.status(201).send({
        connectionId: result.connectionId,
        // Everything the confirmation screen needs to show both the provider's number and ours.
        accounts: result.discovery.accounts.map(serializeDiscovered),
        errors: result.discovery.errors,
      })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** Re-runs discovery, for a confirmation screen that was abandoned or needs revisiting. */
  fastify.get<{ Params: { id: string } }>(
    '/api/connections/:id/discover',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      try {
        const discovery = await withHouseholdContext(deps, user.id, async (context) =>
          discoverAccounts(context, request.params.id, fetcher),
        )

        return reply.send({
          accounts: discovery.accounts.map(serializeDiscovered),
          errors: discovery.errors,
        })
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  /** Commits the user's answers, then runs the first real sync. */
  fastify.post<{ Params: { id: string } }>(
    '/api/connections/:id/confirm',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      const body = confirmBody.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid account confirmation' })
      }

      try {
        const result = await withHouseholdContext(deps, user.id, async (context) => {
          // Re-discovered rather than trusted from the client: the balances being confirmed must be
          // ones the provider actually reported, not numbers a caller supplied.
          const discovery = await discoverAccounts(context, request.params.id, fetcher)

          const confirmed = await confirmAccounts(
            context,
            request.params.id,
            body.data.accounts,
            discovery.accounts,
          )

          const sync = await runSync(context, request.params.id, fetcher, 'manual')
          return { confirmed, sync }
        })

        return reply.send({
          created: result.confirmed.created,
          updated: result.confirmed.updated,
          synced: result.sync.ran && result.sync.ok,
        })
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  /**
   * Replaces the credential on an existing connection.
   *
   * Distinct from creating a new one, and deliberately so: a new connection would orphan every
   * account behind the old one and duplicate them on the next discovery.
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/connections/:id/reconnect',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      const body = setupTokenBody.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'A SimpleFIN setup token is required' })
      }

      try {
        await withHouseholdContext(deps, user.id, async (context) =>
          reconnect(context, request.params.id, body.data.setupToken, fetcher),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  /** A user-triggered refresh. Rate limited by the request budget, not by this route. */
  fastify.post<{ Params: { id: string } }>('/api/connections/:id/sync', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const attempt = await withHouseholdContext(deps, user.id, async (context) =>
        runSync(context, request.params.id, fetcher, 'manual'),
      )

      if (!attempt.ran) {
        // 429 with the reason and when to try again — a refusal is expected, not an error.
        return reply.status(429).send({ error: attempt.reason, retryAfter: attempt.retryAfter })
      }

      if (!attempt.ok) {
        return reply.status(502).send({ error: attempt.error })
      }

      return reply.send({
        accountsUpdated: attempt.outcome.accountsUpdated,
        transactionsUpserted: attempt.outcome.transactionsUpserted,
        transactionsVoided: attempt.outcome.transactionsVoided,
        // Surfaced rather than swallowed — the provider complaining is the only signal a user gets
        // that an institution behind a green-looking connection has gone stale.
        errors: attempt.outcome.errors,
      })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** Connection health, for the settings screen. */
  fastify.get('/api/connections', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const connections = await withHouseholdContext(deps, user.id, async (context) => {
        const rows = await context.client.query<{
          id: string
          status: string
          last_success_at: Date | null
          last_error: Buffer | null
          account_count: string
        }>(
          `select c.id, c.status, c.last_success_at, c.last_error,
                  (select count(*) from accounts a where a.connection_id = c.id) as account_count
             from connections c
            order by c.created_at`,
        )

        return rows.rows.map((row) => ({
          id: row.id,
          status: row.status,
          lastSuccessAt: row.last_success_at,
          accountCount: Number(row.account_count),
          errors:
            row.last_error === null ? [] : context.cipher.decryptJson<string[]>(row.last_error),
        }))
      })

      return reply.send({ connections })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })
}

/**
 * Shapes a discovered account for the confirmation screen.
 *
 * Both numbers are sent deliberately: the provider's raw balance and our reading of it. The user is
 * being asked to adjudicate between them, which they cannot do if we only show our answer.
 *
 * Money crosses the boundary as a **decimal string**, never a JSON number — JSON numbers are
 * IEEE-754 doubles and lose precision above 2^53.
 */
function serializeDiscovered(account: {
  simplefinAccountId: string
  providerName: string
  institutionName: string | null
  currency: string | null
  providerBalanceCents: bigint
  interpretedBalanceCents: bigint
  typeGuess: { type: string; confidence: string; basis: string }
  suggestedSignInverted: boolean | null
  anomaly: { severity: string; reason: string } | null
  alreadyLinked: boolean
}) {
  return {
    simplefinAccountId: account.simplefinAccountId,
    providerName: account.providerName,
    institutionName: account.institutionName,
    currency: account.currency,
    providerBalance: centsToDecimalString(account.providerBalanceCents),
    interpretedBalance: centsToDecimalString(account.interpretedBalanceCents),
    suggestedType: account.typeGuess.type,
    typeConfidence: account.typeGuess.confidence,
    typeBasis: account.typeGuess.basis,
    suggestedSignInverted: account.suggestedSignInverted,
    anomaly: account.anomaly,
    alreadyLinked: account.alreadyLinked,
  }
}
