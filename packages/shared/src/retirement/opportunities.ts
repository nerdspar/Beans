import type { ReferenceKey, ReferenceRow } from './reference.js'
import { lookupReference } from './reference.js'

/**
 * The opportunities engine: what is worth knowing about this tax year, and whether it is done.
 *
 * **Beans describes mechanisms and shows your numbers against them. It never tells anyone what to
 * do with their money.** Every rule here states what a thing *is*, what the household's own figure
 * is, and links to the authority. None of them say "you should". Friends use this app, and a
 * confidently wrong instruction about somebody's retirement is worse than saying nothing at all.
 *
 * A rule that cannot answer says why it cannot, in a way the screen can act on: a missing
 * statutory figure is a different problem from an unanswered plan question, and conflating them
 * would send somebody to the wrong screen.
 */

export type OpportunityKey =
  | 'pro_rata_conflict'
  | 'ira_rollin_opportunity'
  | 'mega_backdoor_headroom'
  | 'employee_deferral_limit'
  | 'hsa_contribution'
  | 'hsa_invested_share'
  | 'tax_loss_harvesting'

/**
 * What a rule concluded.
 *
 * A union rather than a status string plus optional fields, so a screen cannot render a dollar
 * figure next to "not applicable". The blocked cases carry what is missing, because "unavailable"
 * with no reason is an answer nobody can act on.
 */
export type OpportunityOutcome =
  /** Does not apply to this household, and why. The reason is shown — silence invites a bug report. */
  | { kind: 'not_applicable'; reason: string }
  /** Needs a statutory figure nobody has approved yet. Points at the reference screen. */
  | { kind: 'needs_reference'; missing: ReferenceKey[] }
  /** Needs an answer only the household can give. Points at the question. */
  | { kind: 'needs_answer'; question: string }
  /** Beans cannot compute this at all yet, and says so rather than estimating. */
  | { kind: 'unavailable'; reason: string }
  /** Something true about the household's position, with the figure that makes it true. */
  | { kind: 'informational'; detail: string; amountCents?: bigint }

export type Opportunity = {
  key: OpportunityKey
  title: string
  /** What the mechanism is, in plain language. Never phrased as advice. */
  mechanism: string
  /** The authority. Every rule that depends on law links to it. */
  sourceUrl: string
  outcome: OpportunityOutcome
}

/** One account, as the rules need to see it. */
export type OpportunityAccount = {
  id: string
  name: string
  type: string
  taxTreatment: string
  balanceCents: bigint | null
  /** Null means nobody has said whether this is an employer plan or an IRA. */
  isEmployerPlan: boolean | null
  allowsAfterTaxContributions: boolean | null
  allowsInPlanRothConversion: boolean | null
  allowsInServiceWithdrawal: boolean | null
  acceptsIraRollIns: boolean | null
}

export type OpportunityInput = {
  taxYear: number
  accounts: readonly OpportunityAccount[]
  reference: readonly ReferenceRow[]
}

/** Collects the reference figures a rule needs, or reports which are not approved. */
function requireReference(
  input: OpportunityInput,
  keys: readonly { key: ReferenceKey; unit: 'cents' | 'years' | 'basis_points' }[],
): { ok: true; values: Map<ReferenceKey, bigint> } | { ok: false; missing: ReferenceKey[] } {
  const values = new Map<ReferenceKey, bigint>()
  const missing: ReferenceKey[] = []

  for (const want of keys) {
    const found = lookupReference(input.reference, want.key, input.taxYear, want.unit)
    if (found.status === 'ok') values.set(want.key, found.value)
    else missing.push(want.key)
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, values }
}

/** Investment accounts holding pre-tax money. The pool both IRA rules work over. */
function preTaxInvestments(input: OpportunityInput): OpportunityAccount[] {
  return input.accounts.filter(
    (account) =>
      account.type === 'investment' &&
      account.taxTreatment === 'traditional' &&
      (account.balanceCents ?? 0n) > 0n,
  )
}

/**
 * The pro-rata conflict, which the spec calls out as high value — and it is, because Beans can see
 * the balances that cause it and the person usually cannot see the consequence.
 *
 * **401(k) balances do not count.** Only IRAs — traditional, SEP and SIMPLE — enter the
 * calculation, so an account whose kind nobody has stated blocks the rule rather than being
 * guessed at. Guessing wrong inverts the answer: it would tell somebody a conversion is clean when
 * it is not.
 */
function proRataConflict(input: OpportunityInput): OpportunityOutcome {
  const preTax = preTaxInvestments(input)

  const unanswered = preTax.filter((account) => account.isEmployerPlan === null)
  if (unanswered.length > 0) {
    return {
      kind: 'needs_answer',
      question: unanswered.map((account) => account.name).join(', '),
    }
  }

  const iras = preTax.filter((account) => account.isEmployerPlan === false)
  const total = iras.reduce((sum, account) => sum + (account.balanceCents ?? 0n), 0n)

  /*
   * The boundary is exactly zero, and the spec asks for a test at it. A single dollar of pre-tax
   * IRA money makes a conversion partially taxable; none at all makes it clean. There is no
   * "nearly zero" in this rule.
   */
  if (total === 0n) {
    return {
      kind: 'not_applicable',
      reason: 'No pre-tax money in an IRA, so a conversion would not be split pro rata.',
    }
  }

  return {
    kind: 'informational',
    amountCents: total,
    detail: iras.map((account) => account.name).join(', '),
  }
}

/**
 * Rolling IRA money into an employer plan clears the pro-rata calculation.
 *
 * Stated because the interaction is counter-intuitive and the commonly given advice runs the other
 * way: consolidating an old 401(k) *into* an IRA is what most people are told to do, and it is
 * exactly what creates a pro-rata problem. Beans points at the mechanism; it does not tell anybody
 * to use it.
 */
function iraRollInOpportunity(input: OpportunityInput): OpportunityOutcome {
  const conflict = proRataConflict(input)
  if (conflict.kind !== 'informational') {
    return { kind: 'not_applicable', reason: 'No pre-tax IRA balance to move.' }
  }

  const accepting = input.accounts.filter(
    (account) => account.isEmployerPlan === true && account.acceptsIraRollIns === true,
  )

  if (accepting.length === 0) {
    const unanswered = input.accounts.some(
      (account) => account.isEmployerPlan === true && account.acceptsIraRollIns === null,
    )
    return unanswered
      ? { kind: 'needs_answer', question: 'Does your employer plan accept a rollover from an IRA?' }
      : { kind: 'not_applicable', reason: 'No employer plan here accepts a rollover from an IRA.' }
  }

  return { kind: 'informational', detail: accepting.map((account) => account.name).join(', ') }
}

/**
 * Mega-backdoor headroom.
 *
 * **Gated on the plan allowing both after-tax contributions and a way to get them out** — either
 * in-plan conversion or in-service withdrawal. Without both, the strategy does not exist for this
 * household and the rule says so rather than describing something they cannot do.
 *
 * The figure itself needs the annual additions limit, which is statutory, so it waits on the
 * reference table.
 */
function megaBackdoorHeadroom(input: OpportunityInput): OpportunityOutcome {
  const plans = input.accounts.filter((account) => account.isEmployerPlan === true)

  if (plans.length === 0) {
    return { kind: 'not_applicable', reason: 'No employer plan recorded.' }
  }

  const unanswered = plans.some(
    (plan) =>
      plan.allowsAfterTaxContributions === null ||
      (plan.allowsInPlanRothConversion === null && plan.allowsInServiceWithdrawal === null),
  )
  if (unanswered) {
    return {
      kind: 'needs_answer',
      question: 'Does your plan allow after-tax contributions, and a way to convert or withdraw them?',
    }
  }

  const eligible = plans.some(
    (plan) =>
      plan.allowsAfterTaxContributions === true &&
      (plan.allowsInPlanRothConversion === true || plan.allowsInServiceWithdrawal === true),
  )
  if (!eligible) {
    return {
      kind: 'not_applicable',
      reason: 'This plan does not allow both after-tax contributions and a way to get them out.',
    }
  }

  const needed = requireReference(input, [
    { key: 'total_annual_additions_limit', unit: 'cents' },
    { key: 'employee_deferral_limit', unit: 'cents' },
  ])
  if (!needed.ok) return { kind: 'needs_reference', missing: needed.missing }

  /*
   * Headroom is the annual additions limit minus deferrals minus employer contributions, and Beans
   * knows neither of the last two — a payroll deferral never appears as a transaction (§19.5). So
   * the limit is reported and the subtraction is left to the reader rather than guessed.
   */
  return {
    kind: 'informational',
    amountCents: needed.values.get('total_annual_additions_limit') ?? 0n,
    detail: 'Your own deferrals and any employer contribution come off this figure.',
  }
}

/** The elective deferral limit. Purely a statutory lookup until payroll data exists. */
function employeeDeferralLimit(input: OpportunityInput): OpportunityOutcome {
  const needed = requireReference(input, [{ key: 'employee_deferral_limit', unit: 'cents' }])
  if (!needed.ok) return { kind: 'needs_reference', missing: needed.missing }

  return {
    kind: 'informational',
    amountCents: needed.values.get('employee_deferral_limit') ?? 0n,
    /*
     * Beans cannot track progress against this. A 401(k) deferral is taken from pay before it ever
     * reaches an account Beans can see, so there is no transaction to count — and a progress bar
     * fed by nothing would be worse than no progress bar.
     */
    detail: 'Beans cannot see payroll deferrals, so it cannot tell how much of this you have used.',
  }
}

function hsaContribution(input: OpportunityInput): OpportunityOutcome {
  const hsa = input.accounts.filter((account) => account.taxTreatment === 'hsa')
  if (hsa.length === 0) return { kind: 'not_applicable', reason: 'No HSA recorded.' }

  const needed = requireReference(input, [
    { key: 'hsa_contribution_limit_self', unit: 'cents' },
    { key: 'hsa_contribution_limit_family', unit: 'cents' },
  ])
  if (!needed.ok) return { kind: 'needs_reference', missing: needed.missing }

  return {
    kind: 'informational',
    amountCents: needed.values.get('hsa_contribution_limit_self') ?? 0n,
    detail: 'Self-only coverage. Family coverage has its own limit.',
  }
}

/**
 * How much of an HSA sits in cash rather than invested.
 *
 * **Descriptive, not prescriptive**, and the spec says so explicitly. Beans states the split; what
 * somebody does about it depends on whether they expect to spend it soon, which Beans has no way
 * of knowing.
 *
 * Unavailable for now: telling cash from investments inside an account needs holdings, and
 * coverage of those is thin (§10.1). Reporting "0% invested" for an account whose positions were
 * never reported would be a confident wrong answer.
 */
function hsaInvestedShare(input: OpportunityInput): OpportunityOutcome {
  const hsa = input.accounts.filter((account) => account.taxTreatment === 'hsa')
  if (hsa.length === 0) return { kind: 'not_applicable', reason: 'No HSA recorded.' }

  return {
    kind: 'unavailable',
    reason:
      'Telling cash from investments inside an account needs holdings, and not every provider reports them.',
  }
}

/**
 * Tax-loss harvesting, which Beans cannot do.
 *
 * A stub on purpose, and the spec asks for exactly this: it needs cost basis, which Beans does not
 * have. Present as a named gap rather than absent, so the question "why doesn't it mention
 * harvesting" has an answer on the screen instead of in somebody's head.
 */
function taxLossHarvesting(): OpportunityOutcome {
  return {
    kind: 'unavailable',
    reason: 'Needs cost basis, which no provider reports to Beans.',
  }
}

type RuleDefinition = {
  key: OpportunityKey
  title: string
  mechanism: string
  sourceUrl: string
  evaluate: (input: OpportunityInput) => OpportunityOutcome
}

/**
 * Every rule, in the order they are shown.
 *
 * Pro-rata leads because it is the one most likely to be both true and unknown to the reader: the
 * balances that cause it are ordinary, and the consequence only appears at conversion time.
 */
const RULES: readonly RuleDefinition[] = [
  {
    key: 'pro_rata_conflict',
    title: 'Pre-tax IRA money affects a Roth conversion',
    mechanism:
      'A conversion is taxed in proportion to the pre-tax share of all your traditional, SEP and SIMPLE IRAs combined — not just the account being converted. 401(k) balances are not counted.',
    sourceUrl: 'https://www.irs.gov/publications/p590a',
    evaluate: proRataConflict,
  },
  {
    key: 'ira_rollin_opportunity',
    title: 'An employer plan can accept IRA money',
    mechanism:
      'Moving pre-tax IRA money into an employer plan removes it from the pro-rata calculation. Consolidating a 401(k) into an IRA does the reverse, which is the more commonly given advice.',
    sourceUrl: 'https://www.irs.gov/publications/p590a',
    evaluate: iraRollInOpportunity,
  },
  {
    key: 'mega_backdoor_headroom',
    title: 'After-tax contributions beyond the deferral limit',
    mechanism:
      'Some plans allow after-tax contributions above the elective deferral limit, up to the combined annual additions limit, and allow converting them to Roth. Both parts are needed for this to exist.',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-401k-and-profit-sharing-plan-contribution-limits',
    evaluate: megaBackdoorHeadroom,
  },
  {
    key: 'employee_deferral_limit',
    title: 'Elective deferral limit',
    mechanism: 'The most you can defer from pay into a 401(k), 403(b) or most 457 plans this year.',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-401k-and-profit-sharing-plan-contribution-limits',
    evaluate: employeeDeferralLimit,
  },
  {
    key: 'hsa_contribution',
    title: 'HSA contribution limit',
    mechanism: 'The most that can go into an HSA this year, which depends on your coverage type.',
    sourceUrl: 'https://www.irs.gov/publications/p969',
    evaluate: hsaContribution,
  },
  {
    key: 'hsa_invested_share',
    title: 'How much of your HSA is invested',
    mechanism:
      'An HSA can hold cash or investments. Which it holds is a fact about the account, not a recommendation.',
    sourceUrl: 'https://www.irs.gov/publications/p969',
    evaluate: hsaInvestedShare,
  },
  {
    key: 'tax_loss_harvesting',
    title: 'Tax-loss harvesting',
    mechanism: 'Realising a loss in a taxable account can offset gains. It needs what you paid.',
    sourceUrl: 'https://www.irs.gov/taxtopics/tc409',
    evaluate: taxLossHarvesting,
  },
]

export function evaluateOpportunities(input: OpportunityInput): Opportunity[] {
  return RULES.map((rule) => ({
    key: rule.key,
    title: rule.title,
    mechanism: rule.mechanism,
    sourceUrl: rule.sourceUrl,
    outcome: rule.evaluate(input),
  }))
}
