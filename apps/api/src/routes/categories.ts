import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  CategoryError,
  applyRules,
  createRule,
  deleteRule,
  listCategories,
  listRules,
  setTransactionCategory,
} from '../repositories/categories.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'

/** Categories, rules, and assigning a category to one transaction. */

export type CategoryRoutesOptions = { auth: Auth; deps: ContextDependencies }

const assignBody = z.object({ categoryId: z.string().uuid().nullable() })

const ruleBody = z.object({
  matchDescription: z.string().trim().min(1).max(200),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  matchAccountId: z.string().uuid().nullable().default(null),
  categoryId: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).optional(),
})

export const categoryRoutes: FastifyPluginAsync<CategoryRoutesOptions> = async (fastify, options) => {
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
    if (error instanceof CategoryError) return reply.status(400).send({ error: error.message })
    return null
  }

  fastify.get('/api/categories', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const categories = await withHouseholdContext(deps, user.id, listCategories)
      return reply.header('cache-control', 'no-store').send({ categories })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.put<{ Params: { id: string } }>(
    '/api/transactions/:id/category',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      const body = assignBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid category' })

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          setTransactionCategory(context, request.params.id, body.data.categoryId),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.get('/api/rules', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const rules = await withHouseholdContext(deps, user.id, listRules)
      return reply.header('cache-control', 'no-store').send({ rules })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** Creating a rule applies it immediately, to uncategorized transactions only. */
  fastify.post('/api/rules', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = ruleBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid rule' })

    try {
      const result = await withHouseholdContext(deps, user.id, async (context) => {
        const created = await createRule(context, body.data)
        const applied = await applyRules(context)
        return { ...created, ...applied }
      })
      return reply.status(201).send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.delete<{ Params: { id: string } }>('/api/rules/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      await withHouseholdContext(deps, user.id, (context) => deleteRule(context, request.params.id))
      return reply.status(204).send()
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post('/api/rules/apply', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const result = await withHouseholdContext(deps, user.id, applyRules)
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })
}
