import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import {
  CategoryError,
  applyRules,
  createCategory,
  createRule,
  deleteCategory,
  deleteRule,
  listCategories,
  listRules,
  setTransactionCategory,
  updateCategory,
  updateRule,
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
  /*
   * At least one term is required at the edge, not just at the write.
   *
   * A rule with no conditions matches nothing (see `ruleMatches`), so accepting one would silently
   * store something that can never fire — an automation the user believes exists.
   */
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  keywordMode: z.enum(['any', 'all']).default('any'),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  matchAccountId: z.string().uuid().nullable().default(null),
  categoryId: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).optional(),
})

const categoryBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['income', 'expense', 'transfer']),
  parentId: z.string().uuid().nullable().default(null),
})

const categoryPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  parentId: z.string().uuid().nullable().optional(),
})

/** Where anything using the removed category goes. Null leaves it uncategorized, deliberately. */
const categoryDelete = z.object({ reassignTo: z.string().uuid().nullable().default(null) })

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

  /** Editing a rule keeps its id, so its place in the order survives. */
  fastify.patch<{ Params: { id: string } }>('/api/rules/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = ruleBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid rule' })

    try {
      const result = await withHouseholdContext(deps, user.id, async (context) => {
        await updateRule(context, request.params.id, body.data)
        return applyRules(context)
      })
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post('/api/categories', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = categoryBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid category' })

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        createCategory(context, body.data),
      )
      return reply.status(201).send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.patch<{ Params: { id: string } }>('/api/categories/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = categoryPatch.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid category' })

    try {
      await withHouseholdContext(deps, user.id, (context) =>
        updateCategory(context, request.params.id, body.data),
      )
      return reply.status(204).send()
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /**
   * Removing a category moves what used it, and reports how much moved.
   *
   * The counts are the point: "deleted" quietly meaning "and uncategorized four hundred
   * transactions" is something a person discovers a month later in a cash flow chart.
   */
  fastify.delete<{ Params: { id: string } }>('/api/categories/:id', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = categoryDelete.safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'Invalid request' })

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        deleteCategory(context, request.params.id, body.data.reassignTo),
      )
      return reply.send(result)
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
