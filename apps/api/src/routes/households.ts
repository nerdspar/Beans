import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { rebuildHouseholdHistory } from '../balance-history/rebuild.js'
import { ensureDefaultCategories } from '../repositories/categories.js'
import { HOUSEHOLD_COPY, toIsoDate } from '@beans/shared'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import { isDemoUser, type Config } from '../config.js'
import { deliverInvite } from '../mail/deliver-invite.js'
import type { Mailer } from '../mail/mailer.js'
import {
  NoHouseholdError,
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import {
  InviteError,
  acceptInvite,
  createInvite,
  inviteLink,
  listInvites,
  revokeInvite,
} from '../repositories/invites.js'

/**
 * Household and invite endpoints.
 *
 * Every route here resolves the caller's session first and then goes through
 * `withHouseholdContext`. There is deliberately no route that takes a household id from the
 * client — the household is derived from who is asking, never from what they claim.
 */

export type HouseholdRoutesOptions = {
  auth: Auth
  config: Config
  deps: ContextDependencies
  mailer: Mailer
}

const createHouseholdBody = z.object({
  name: z.string().trim().min(1).max(100),
})

const createInviteBody = z.object({
  role: z.enum(['owner', 'member']).default('member'),
  email: z.email().optional(),
})

const joinBody = z.object({
  token: z.string().trim().min(1),
})

export const householdRoutes: FastifyPluginAsync<HouseholdRoutesOptions> = async (
  fastify,
  options,
) => {
  const { auth, config, deps, mailer } = options

  /** Resolves the signed-in user, or replies 401. Returns null when it has already replied. */
  async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: string; email: string } | null> {
    const session = await getSession(auth, request.headers)
    if (session === null) {
      await reply.status(401).send({ error: 'Not signed in' })
      return null
    }
    return { id: session.user.id, email: session.user.email }
  }

  /**
   * Creates a household and makes the caller its owner.
   *
   * The one operation that cannot go through `withHouseholdContext`, because by definition there
   * is no membership to resolve yet.
   */
  fastify.post('/api/households', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = createHouseholdBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'A household name is required' })
    }

    const alreadyBelongs = await withHouseholdContext(deps, user.id, async (ctx) => ctx.householdId)
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof NoHouseholdError) return false
        throw error
      })

    if (alreadyBelongs) {
      return reply.status(409).send({ error: 'You already belong to a household' })
    }

    const { householdId } = await createHousehold(deps, user.id, body.data.name)

    /*
     * Seeded immediately, in its own context, because `createHousehold` cannot use one — there is no
     * membership to resolve until it has finished. A household without categories cannot categorize
     * anything, and there is no later moment that obviously belongs to "first setup".
     */
    await withHouseholdContext(deps, user.id, ensureDefaultCategories)

    return reply.status(201).send({ householdId })
  })

  /** The caller's household and its members. */
  fastify.get('/api/households/me', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const household = await withHouseholdContext(deps, user.id, async (ctx) => {
        const rows = await ctx.client.query<{
          id: string
          name: string
          trust_imported_history: boolean
          user_id: string
          role: 'owner' | 'member'
        }>(
          `select h.id, h.name, h.trust_imported_history, m.user_id, m.role
             from households h
             join household_members m on m.household_id = h.id
            where h.id = $1`,
          [ctx.householdId],
        )

        return {
          id: ctx.householdId,
          name: rows.rows[0]?.name ?? '',
          trustImportedHistory: rows.rows[0]?.trust_imported_history ?? false,
          role: ctx.role,
          members: rows.rows.map((r) => ({ userId: r.user_id, role: r.role })),
        }
      })

      return reply.send(household)
    } catch (error) {
      if (error instanceof NoHouseholdError) {
        // Not an error condition — it is the state a brand new user is in, and the client uses it
        // to route them to household creation.
        return reply.status(404).send({ error: 'You do not belong to a household yet' })
      }
      throw error
    }
  })

  /**
   * Renaming.
   *
   * The name stopped being asked for at sign-up — a household is created automatically so nobody
   * has to name a thing they do not yet have a concept of. This is where it gets a real name, at
   * the point it starts to matter, which is when somebody else is about to see it.
   */
  fastify.patch('/api/households/me', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'A household name is required' })
    }

    try {
      const name = await withHouseholdContext(deps, user.id, async (ctx) => {
        await ctx.client.query('update households set name = $1 where id = $2', [
          body.data.name,
          ctx.householdId,
        ])
        return body.data.name
      })

      return reply.send({ name })
    } catch (error) {
      if (error instanceof NoHouseholdError) {
        return reply.status(404).send({ error: 'You do not belong to a household yet' })
      }
      throw error
    }
  })

  /**
   * Whether imported transactions may extend how far back a chart is drawn.
   *
   * Rebuilds every account on the way out, because the setting has no visible effect otherwise —
   * the series is materialized, so flipping a flag without recomputing changes nothing at all and
   * looks exactly like a broken switch.
   *
   * Reversible by construction: `coverage_start_date` is never written here, only read, so turning
   * it off and rebuilding restores the previous chart exactly.
   */
  fastify.patch('/api/households/me/history-trust', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = z.object({ trustImportedHistory: z.boolean() }).safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid setting' })
    }

    try {
      const result = await withHouseholdContext(deps, user.id, async (ctx) => {
        await ctx.client.query('update households set trust_imported_history = $1 where id = $2', [
          body.data.trustImportedHistory,
          ctx.householdId,
        ])

        const rebuilt = await rebuildHouseholdHistory(ctx, toIsoDate(new Date()))
        return { trustImportedHistory: body.data.trustImportedHistory, accounts: rebuilt.length }
      })

      return reply.send(result)
    } catch (error) {
      if (error instanceof NoHouseholdError) {
        return reply.status(404).send({ error: 'You do not belong to a household yet' })
      }
      throw error
    }
  })

  fastify.post('/api/households/invites', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    /*
     * The demo account cannot invite.
     *
     * Tenant isolation keeps a visitor out of other households; it says nothing about them using
     * the deployment's own resources. An invite sends real email, from the operator's domain, on
     * their Resend key, to any address a stranger types — which is a spam relay wearing the app's
     * clothes. Refused here rather than rate-limited, because there is no rate at which it is fine.
     */
    if (isDemoUser(config, user.email)) {
      return reply.status(403).send({ error: HOUSEHOLD_COPY.demoInviteBlocked })
    }

    const body = createInviteBody.safeParse(request.body ?? {})
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid invite request' })
    }

    try {
      const invite = await withHouseholdContext(deps, user.id, async (ctx) =>
        createInvite(ctx, {
          role: body.data.role,
          ...(body.data.email === undefined ? {} : { email: body.data.email }),
        }),
      )

      const link = inviteLink(config.publicUrl, invite.token)

      /**
       * The link is returned regardless, and emailing is best effort.
       *
       * A self-hosted install may have no mail at all, so the copy-paste link is the mechanism and
       * email is a convenience. A delivery failure must not lose the invite the user just created.
       */
      // Which of the four things happened, not a boolean — see deliver-invite.ts.
      const delivery = await deliverInvite(
        mailer,
        { to: body.data.email, link, expiresAt: invite.expiresAt },
        (error) => request.log.warn({ err: error }, 'invite email delivery failed'),
      )

      /*
       * The outcome, every time — including the cases that did no work.
       *
       * A disabled mailer sends nothing and previously logged nothing, so "we never tried" and "we
       * tried and it failed" were indistinguishable from the server side as well as the client side.
       * Neither the address nor the link is logged: one is personal data and the other is a
       * single-use credential.
       */
      request.log.info({ delivery, mailTransport: config.mail.kind }, 'invite created')

      // The token appears here and nowhere else, ever again — only its hash is stored.
      return reply
        .status(201)
        .send({ link, expiresAt: invite.expiresAt, emailed: delivery === 'sent', delivery })
    } catch (error) {
      if (error instanceof InviteError) {
        return reply.status(403).send({ error: error.message })
      }
      if (error instanceof NoHouseholdError) {
        return reply.status(404).send({ error: 'You do not belong to a household yet' })
      }
      throw error
    }
  })

  fastify.get('/api/households/invites', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const invites = await withHouseholdContext(deps, user.id, async (ctx) => listInvites(ctx))
      return reply.send({ invites })
    } catch (error) {
      if (error instanceof NoHouseholdError) {
        return reply.status(404).send({ error: 'You do not belong to a household yet' })
      }
      throw error
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/api/households/invites/:id',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      try {
        await withHouseholdContext(deps, user.id, async (ctx) =>
          revokeInvite(ctx, request.params.id),
        )
        return reply.status(204).send()
      } catch (error) {
        if (error instanceof InviteError) {
          return reply.status(403).send({ error: error.message })
        }
        throw error
      }
    },
  )

  /** Accepts an invite. The caller must be signed in but must not already have a household. */
  fastify.post('/api/households/join', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = joinBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'An invite token is required' })
    }

    try {
      const result = await acceptInvite(deps, user.id, body.data.token)
      return reply.send(result)
    } catch (error) {
      if (error instanceof InviteError) {
        // 400 rather than 403: the token is malformed, spent, or expired — all of which are about
        // the request, not about the caller's permissions.
        return reply.status(400).send({ error: error.message })
      }
      throw error
    }
  })
}
