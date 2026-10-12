import {
  TAX_TREATMENTS,
  centsToDecimalString,
  parseDecimalToCents,
  toIsoDate,
  type ScenarioProjection,
} from '@beans/shared'
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
  RetirementError,
  addRetirementMember,
  deleteRetirementMember,
  ensureRetirementPlan,
  readLoanPayoffYears,
  readRetirementPlan,
  readSpendingAssumptions,
  setDefaultScenario,
  setSpendingAssumption,
  updateRetirementMember,
  updateRetirementProfile,
  updateRetirementScenario,
} from '../repositories/retirement.js'
import {
  deleteContributionRoute,
  readAccountTaxBuckets,
  readContributionRouting,
  readPlanFeatures,
  setAccountTaxBuckets,
  setContributionRoute,
  setPlanFeatures,
} from '../repositories/retirement-accounts.js'
import { runRetirementProjection } from '../retirement/plan.js'
import { moneyIn, moneyOut, serializeProjection, toMemberInput } from '../retirement/wire.js'

/**
 * The retirement planner's API (ARCHITECTURE.md §19).
 *
 * **Money crosses this boundary as a decimal string, never a JSON number**, in both directions. A
 * JSON number is an IEEE-754 double and silently loses precision above 2^53 — which a retirement
 * projection reaches sooner than most things, because it compounds a portfolio for forty years.
 *
 * Rates stay integers: they are basis points, and `450` has no precision problem to begin with.
 */

export type RetirementRoutesOptions = { auth: Auth; deps: ContextDependencies }

/** A decimal string, optionally negative. Spending is negative throughout this feature. */
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const uuid = z.string().uuid()

/**
 * Bounds on a rate, in basis points.
 *
 * The lower bound is above -100%: a real return of -100% or worse wipes the portfolio every year
 * and the projection engine refuses it outright rather than dividing by zero. The upper bound is
 * generous nonsense-prevention rather than a judgement about markets — 200% real is not a scenario,
 * it is a typo.
 */
const rate = z.number().int().gt(-10_000).max(20_000)

const profileBody = z.object({
  retirementEffectiveRateBasisPoints: z.number().int().min(0).max(9_999).optional(),
  /** Present and null clears it; absent leaves it alone. The two are different operations. */
  withdrawalOrder: z.array(z.enum(TAX_TREATMENTS)).max(TAX_TREATMENTS.length).nullable().optional(),
  pre65HealthcareAnnual: money.nullable().optional(),
})

const memberBody = z.object({
  displayName: z.string().trim().min(1).max(120),
  birthYear: z.number().int().min(1_900).max(2_100),
  targetRetirementDate: isoDate.nullable().optional(),
  socialSecurityClaimAge: z.number().int().min(50).max(80).nullable().optional(),
  socialSecurityAnnualBenefit: money.nullable().optional(),
  lifeExpectancy: z.number().int().min(50).max(120).nullable().optional(),
})

const scenarioBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  preRetirementReturnBasisPoints: rate.optional(),
  postRetirementReturnBasisPoints: rate.optional(),
  annualSpendingOverride: money.nullable().optional(),
  retirementYearsOffset: z.number().int().min(-30).max(30).nullable().optional(),
})

const spendingBody = z.object({
  treatment: z.enum(['continues', 'stops', 'adjusted']),
  /** Basis points of today's spending that continues. Required when adjusted; see the repository. */
  adjustmentBasisPoints: z.number().int().min(0).max(50_000).nullable().optional(),
  lastYear: z.number().int().min(2_000).max(2_200).nullable().optional(),
})

const bucketsBody = z.object({
  asOfDate: isoDate,
  /**
   * An empty list removes the anchor, which is how somebody undoes a split and falls back to the
   * account-level treatment. A whole date at a time, because a partial anchor is a wrong anchor.
   */
  buckets: z
    .array(z.object({ treatment: z.enum(TAX_TREATMENTS), balance: money }))
    .max(TAX_TREATMENTS.length),
})

const routingBody = z.object({
  treatment: z.enum(TAX_TREATMENTS),
  annualAmount: money,
  active: z.boolean().optional(),
})

/**
 * Every flag is a **nullable** boolean and `null` means "not asked".
 *
 * `.optional()` leaves a field alone; an explicit `null` clears it back to unasked. Collapsing the
 * two would make an unanswered plan indistinguishable from a restrictive one, and the phase B rules
 * are gated on these precisely so nothing tells somebody a strategy is available when their plan
 * does not offer it.
 */
const planFeaturesBody = z.object({
  allowsAfterTaxContributions: z.boolean().nullable().optional(),
  allowsInPlanRothConversion: z.boolean().nullable().optional(),
  allowsInServiceWithdrawal: z.boolean().nullable().optional(),
  acceptsIraRollIns: z.boolean().nullable().optional(),
  employerMatchDescription: z.string().trim().max(500).nullable().optional(),
})

export const retirementRoutes: FastifyPluginAsync<RetirementRoutesOptions> = async (
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
    /*
     * 404 rather than 403. A RetirementError from these repositories means the row is not visible
     * to this caller — another household's, or another member's private account — and saying
     * "forbidden" would confirm that something exists which the caller is not allowed to know
     * about.
     */
    if (error instanceof RetirementError) return reply.status(404).send({ error: error.message })
    return null
  }

  /** The plan as the wizard needs it, creating nothing. */
  fastify.get('/api/retirement', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const payload = await withHouseholdContext(deps, user.id, async (context) => {
        const plan = await readRetirementPlan(context)
        if (plan === null) {
          // Not an error: "you have not started" is a state the wizard renders.
          return { started: false as const }
        }

        const buckets = await readAccountTaxBuckets(context)
        const routing = await readContributionRouting(context)
        const features = await readPlanFeatures(context)
        const payoffYears = await readLoanPayoffYears(context)
        const assumptions = await readSpendingAssumptions(context, plan.profile.id)

        return {
          started: true as const,
          profile: {
            id: plan.profile.id,
            retirementEffectiveRateBasisPoints: plan.profile.retirementEffectiveRateBasisPoints,
            withdrawalOrder: plan.profile.withdrawalOrder,
            pre65HealthcareAnnual: moneyOut(plan.profile.pre65HealthcareAnnualCents),
          },
          members: plan.members.map((member) => ({
            id: member.id,
            displayName: member.displayName,
            userId: member.userId,
            birthYear: member.birthYear,
            targetRetirementDate: member.targetRetirementDate,
            socialSecurityClaimAge: member.socialSecurityClaimAge,
            socialSecurityAnnualBenefit: moneyOut(member.socialSecurityAnnualBenefitCents),
            lifeExpectancy: member.lifeExpectancy,
          })),
          scenarios: plan.scenarios.map((scenario) => ({
            id: scenario.id,
            name: scenario.name,
            preRetirementReturnBasisPoints: scenario.preRetirementReturnBasisPoints,
            postRetirementReturnBasisPoints: scenario.postRetirementReturnBasisPoints,
            annualSpendingOverride: moneyOut(scenario.annualSpendingOverrideCents),
            retirementYearsOffset: scenario.retirementYearsOffset,
            isDefault: scenario.isDefault,
          })),
          taxBuckets: buckets.map((entry) => ({
            accountId: entry.accountId,
            anchors: entry.anchors.map((anchor) => ({
              asOfDate: anchor.asOfDate,
              buckets: anchor.buckets.map((bucket) => ({
                treatment: bucket.treatment,
                balance: centsToDecimalString(bucket.balanceCents),
              })),
            })),
          })),
          routing: routing.map((route) => ({
            accountId: route.accountId,
            treatment: route.treatment,
            annualAmount: centsToDecimalString(route.annualCents),
            active: route.active,
          })),
          planFeatures: features.map((entry) => ({
            accountId: entry.accountId,
            allowsAfterTaxContributions: entry.allowsAfterTaxContributions,
            allowsInPlanRothConversion: entry.allowsInPlanRothConversion,
            allowsInServiceWithdrawal: entry.allowsInServiceWithdrawal,
            acceptsIraRollIns: entry.acceptsIraRollIns,
            employerMatchDescription: entry.employerMatchDescription,
            answeredAt: entry.answeredAt?.toISOString() ?? null,
          })),
          /**
           * The answers already given, so revisiting the review shows them rather than resetting
           * every category to the default. A form that silently discards a previous answer is
           * worse than one that never offered to remember it.
           */
          spendingAssumptions: assumptions.map((assumption) => ({
            categoryId: assumption.categoryId,
            treatment: assumption.treatment,
            adjustmentBasisPoints: assumption.adjustmentBasisPoints,
            lastYear: assumption.lastYear,
            reviewedAt: assumption.reviewedAt?.toISOString() ?? null,
          })),
          /** Offered for the spending review to pre-fill with. Never applied automatically. */
          loanPayoffYears: payoffYears,
        }
      })

      return reply.send(payload)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** Starts the plan, or returns the existing one. Idempotent — the wizard is revisitable. */
  fastify.post('/api/retirement', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const plan = await withHouseholdContext(deps, user.id, ensureRetirementPlan)
      return reply.send({ profileId: plan.profile.id })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.patch('/api/retirement/profile', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = profileBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid profile' })

    try {
      await withHouseholdContext(deps, user.id, (context) =>
        updateRetirementProfile(context, {
          ...(body.data.retirementEffectiveRateBasisPoints === undefined
            ? {}
            : {
                retirementEffectiveRateBasisPoints:
                  body.data.retirementEffectiveRateBasisPoints,
              }),
          ...('withdrawalOrder' in body.data
            ? { withdrawalOrder: body.data.withdrawalOrder ?? null }
            : {}),
          ...('pre65HealthcareAnnual' in body.data
            ? { pre65HealthcareAnnualCents: moneyIn(body.data.pre65HealthcareAnnual) ?? null }
            : {}),
        }),
      )
      return reply.status(204).send()
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post('/api/retirement/members', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = memberBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid member' })

    try {
      const id = await withHouseholdContext(deps, user.id, async (context) => {
        // Creates the plan if this is the first thing the wizard writes.
        const plan = await ensureRetirementPlan(context)
        return addRetirementMember(context, plan.profile.id, toMemberInput(body.data))
      })
      return reply.status(201).send({ id })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.patch<{ Params: { id: string } }>(
    '/api/retirement/members/:id',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.id).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      const body = memberBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid member' })

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          updateRetirementMember(context, request.params.id, toMemberInput(body.data)),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/api/retirement/members/:id',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.id).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          deleteRetirementMember(context, request.params.id),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.patch<{ Params: { id: string } }>(
    '/api/retirement/scenarios/:id',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.id).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      const body = scenarioBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid scenario' })

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          updateRetirementScenario(context, request.params.id, {
            ...(body.data.name === undefined ? {} : { name: body.data.name }),
            ...(body.data.preRetirementReturnBasisPoints === undefined
              ? {}
              : { preRetirementReturnBasisPoints: body.data.preRetirementReturnBasisPoints }),
            ...(body.data.postRetirementReturnBasisPoints === undefined
              ? {}
              : { postRetirementReturnBasisPoints: body.data.postRetirementReturnBasisPoints }),
            ...('annualSpendingOverride' in body.data
              ? { annualSpendingOverrideCents: moneyIn(body.data.annualSpendingOverride) ?? null }
              : {}),
            ...('retirementYearsOffset' in body.data
              ? { retirementYearsOffset: body.data.retirementYearsOffset ?? null }
              : {}),
          }),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/api/retirement/scenarios/:id/default',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.id).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          setDefaultScenario(context, request.params.id),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.put<{ Params: { categoryId: string } }>(
    '/api/retirement/spending/:categoryId',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.categoryId).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      const body = spendingBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid assumption' })

      try {
        await withHouseholdContext(deps, user.id, async (context) => {
          const plan = await ensureRetirementPlan(context)
          await setSpendingAssumption(context, plan.profile.id, {
            categoryId: request.params.categoryId,
            treatment: body.data.treatment,
            ...('adjustmentBasisPoints' in body.data
              ? { adjustmentBasisPoints: body.data.adjustmentBasisPoints ?? null }
              : {}),
            ...('lastYear' in body.data ? { lastYear: body.data.lastYear ?? null } : {}),
            // The clock, legitimately: this records when a human actually answered.
            reviewedAt: new Date(),
          })
        })
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.put<{ Params: { accountId: string } }>(
    '/api/retirement/accounts/:accountId/buckets',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.accountId).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      const body = bucketsBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid breakdown' })

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          setAccountTaxBuckets(
            context,
            request.params.accountId,
            body.data.asOfDate,
            body.data.buckets.map((bucket) => ({
              treatment: bucket.treatment,
              balanceCents: parseDecimalToCents(bucket.balance),
            })),
          ),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.put<{ Params: { accountId: string } }>(
    '/api/retirement/accounts/:accountId/routing',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.accountId).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      const body = routingBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid routing' })

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          setContributionRoute(
            context,
            request.params.accountId,
            body.data.treatment,
            parseDecimalToCents(body.data.annualAmount),
            body.data.active ?? true,
          ),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.delete<{ Params: { accountId: string; treatment: string } }>(
    '/api/retirement/accounts/:accountId/routing/:treatment',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      const treatment = z.enum(TAX_TREATMENTS).safeParse(request.params.treatment)
      if (!uuid.safeParse(request.params.accountId).success || !treatment.success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          deleteContributionRoute(context, request.params.accountId, treatment.data),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  fastify.put<{ Params: { accountId: string } }>(
    '/api/retirement/accounts/:accountId/plan-features',
    async (request, reply) => {
      const user = await requireUser(request, reply)
      if (user === null) return

      if (!uuid.safeParse(request.params.accountId).success) {
        return reply.status(404).send({ error: 'Not found' })
      }

      const body = planFeaturesBody.safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'Invalid answers' })

      try {
        await withHouseholdContext(deps, user.id, (context) =>
          setPlanFeatures(context, request.params.accountId, {
            ...('allowsAfterTaxContributions' in body.data
              ? { allowsAfterTaxContributions: body.data.allowsAfterTaxContributions ?? null }
              : {}),
            ...('allowsInPlanRothConversion' in body.data
              ? { allowsInPlanRothConversion: body.data.allowsInPlanRothConversion ?? null }
              : {}),
            ...('allowsInServiceWithdrawal' in body.data
              ? { allowsInServiceWithdrawal: body.data.allowsInServiceWithdrawal ?? null }
              : {}),
            ...('acceptsIraRollIns' in body.data
              ? { acceptsIraRollIns: body.data.acceptsIraRollIns ?? null }
              : {}),
            ...('employerMatchDescription' in body.data
              ? { employerMatchDescription: body.data.employerMatchDescription ?? null }
              : {}),
            answeredAt: new Date(),
          }),
        )
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply) ?? Promise.reject(error)
      }
    },
  )

  /**
   * Runs the plan. Computed server-side rather than in the browser.
   *
   * The engine lives in `packages/shared` and the client could in principle run it, but it needs a
   * trailing year of transactions plus every retirement table — none of which are in the working
   * set. Shipping all of that to the browser to avoid one request would be the wrong trade.
   */
  fastify.get('/api/retirement/projection', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        // The clock, legitimately: a projection of the future starts from the actual present.
        runRetirementProjection(context, { today: toIsoDate(new Date()) }),
      )

      if (!result.ready) {
        /*
         * 200, not 4xx. An incomplete plan is the normal state of a plan somebody has not finished,
         * and the wizard renders the list of what is missing. A 4xx would make the client treat a
         * perfectly ordinary situation as a failure.
         */
        return reply.send({ ready: false, missing: result.missing })
      }

      return reply.send({
        ready: true,
        startYear: result.startYear,
        endYear: result.endYear,
        /** Non-empty means the baseline contains guesses, and the UI must say so. */
        unreviewedCategoryIds: result.unreviewedCategoryIds,
        retirementEffectiveRateBasisPoints: result.retirementEffectiveRateBasisPoints,
        /** Today's split and what it is worth after the assumed tax. Money as strings, as always. */
        openingBuckets: result.openingBuckets.map((bucket) => ({
          treatment: bucket.treatment,
          balance: centsToDecimalString(bucket.balanceCents),
        })),
        afterTax: {
          nominal: centsToDecimalString(result.afterTax.nominalCents),
          afterTax: centsToDecimalString(result.afterTax.afterTaxCents),
          deferredTax: centsToDecimalString(result.afterTax.deferredTaxCents),
          ignoresEmbeddedGains: result.afterTax.ignoresEmbeddedGains,
        },
        monthsObserved: result.monthsObserved,
        annualizedFromPartialYear: result.annualizedFromPartialYear,
        projections: result.projections.map(serializeProjection),
      })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })
}
