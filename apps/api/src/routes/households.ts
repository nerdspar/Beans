import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import type { Config } from '../config.js'
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
          user_id: string
          role: 'owner' | 'member'
        }>(
          `select h.id, h.name, m.user_id, m.role
             from households h
             join household_members m on m.household_id = h.id
            where h.id = $1`,
          [ctx.householdId],
        )

        return {
          id: ctx.householdId,
          name: rows.rows[0]?.name ?? '',
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

  fastify.post('/api/households/invites', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

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
      let emailed = false
      if (mailer.enabled && body.data.email !== undefined) {
        try {
          await mailer.send({
            to: body.data.email,
            subject: 'You have been invited to a Beans household',
            text: `You have been invited to share a household on Beans.\n\nOpen this link to join:\n${link}\n\nThe link expires on ${invite.expiresAt.toDateString()}.`,
          })
          emailed = true
        } catch (error) {
          request.log.warn({ err: error }, 'invite email delivery failed')
        }
      }

      // The token appears here and nowhere else, ever again — only its hash is stored.
      return reply.status(201).send({ link, expiresAt: invite.expiresAt, emailed })
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
