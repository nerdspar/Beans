import { describe, expect, it } from 'vitest'
import {
  evaluateOpportunities,
  type Opportunity,
  type OpportunityAccount,
  type OpportunityInput,
  type OpportunityKey,
} from './opportunities.js'
import type { ReferenceRow } from './reference.js'

/**
 * The opportunities engine.
 *
 * The case the spec calls high value is the pro-rata conflict, and the one that would hurt most if
 * wrong is its boundary: a single dollar of pre-tax IRA money makes a conversion partially
 * taxable, none at all makes it clean, and 401(k) balances must not be counted either way.
 *
 * Fixed years throughout (CLAUDE.md).
 */

const YEAR = 2_027

const account = (over: Partial<OpportunityAccount> = {}): OpportunityAccount => ({
  id: 'a1',
  name: 'Rollover IRA',
  type: 'investment',
  taxTreatment: 'traditional',
  balanceCents: 50_000_00n,
  isEmployerPlan: false,
  allowsAfterTaxContributions: null,
  allowsInPlanRothConversion: null,
  allowsInServiceWithdrawal: null,
  acceptsIraRollIns: null,
  ...over,
})

const verified = (key: string, value: bigint, unit: ReferenceRow['unit']): ReferenceRow => ({
  key,
  taxYear: YEAR,
  value,
  unit,
  sourceUrl: 'https://irs.test/source',
  retrievedAt: new Date('2027-01-02T00:00:00.000Z'),
  verifiedAt: new Date('2027-01-02T00:00:00.000Z'),
})

const run = (over: Partial<OpportunityInput> = {}): Opportunity[] =>
  evaluateOpportunities({ taxYear: YEAR, accounts: [], reference: [], ...over })

const rule = (results: Opportunity[], key: OpportunityKey): Opportunity =>
  results.find((entry) => entry.key === key)!

describe('pro-rata conflict', () => {
  it('reports the combined pre-tax IRA balance', () => {
    const outcome = rule(
      run({
        accounts: [
          account({ id: 'a', name: 'Rollover IRA', balanceCents: 50_000_00n }),
          account({ id: 'b', name: 'SEP IRA', balanceCents: 20_000_00n }),
        ],
      }),
      'pro_rata_conflict',
    ).outcome

    expect(outcome).toMatchObject({ kind: 'informational', amountCents: 70_000_00n })
  })

  it('does not count a 401(k) balance', () => {
    /*
     * The spec names this explicitly, and it inverts the answer if got wrong: a household whose
     * only pre-tax money is in an employer plan has a clean conversion, and telling them otherwise
     * would send them to solve a problem they do not have.
     */
    const outcome = rule(
      run({
        accounts: [
          account({ id: 'plan', name: 'Workplace 401(k)', isEmployerPlan: true, balanceCents: 400_000_00n }),
        ],
      }),
      'pro_rata_conflict',
    ).outcome

    expect(outcome.kind).toBe('not_applicable')
  })

  it('is clean at exactly zero, and not at one dollar', () => {
    // The boundary the spec asks for a test at. There is no "nearly zero" in this rule.
    const atZero = rule(
      run({ accounts: [account({ balanceCents: 0n })] }),
      'pro_rata_conflict',
    ).outcome
    expect(atZero.kind).toBe('not_applicable')

    const atOne = rule(
      run({ accounts: [account({ balanceCents: 1_00n })] }),
      'pro_rata_conflict',
    ).outcome
    expect(atOne).toMatchObject({ kind: 'informational', amountCents: 1_00n })
  })

  it('refuses to guess when nobody has said whether an account is an IRA', () => {
    /*
     * Both arrive from SimpleFIN as an investment account with a traditional treatment, and
     * nothing distinguishes them. Guessing from the institution's name would be wrong often
     * enough to matter, and wrong in the direction that says a conversion is clean when it is not.
     */
    const outcome = rule(
      run({ accounts: [account({ isEmployerPlan: null })] }),
      'pro_rata_conflict',
    ).outcome

    expect(outcome.kind).toBe('needs_answer')
  })

  it('ignores Roth and taxable balances entirely', () => {
    const outcome = rule(
      run({
        accounts: [
          account({ id: 'roth', taxTreatment: 'roth', balanceCents: 300_000_00n }),
          account({ id: 'taxable', taxTreatment: 'taxable', balanceCents: 200_000_00n }),
        ],
      }),
      'pro_rata_conflict',
    ).outcome

    expect(outcome.kind).toBe('not_applicable')
  })
})

describe('IRA roll-in', () => {
  it('names a plan that accepts one when there is a pro-rata balance', () => {
    const outcome = rule(
      run({
        accounts: [
          account({ id: 'ira', name: 'Rollover IRA' }),
          account({
            id: 'plan',
            name: 'Workplace 401(k)',
            isEmployerPlan: true,
            acceptsIraRollIns: true,
          }),
        ],
      }),
      'ira_rollin_opportunity',
    ).outcome

    expect(outcome).toMatchObject({ kind: 'informational', detail: 'Workplace 401(k)' })
  })

  it('says nothing when there is no pre-tax IRA money to move', () => {
    const outcome = rule(
      run({
        accounts: [
          account({ id: 'plan', isEmployerPlan: true, acceptsIraRollIns: true }),
        ],
      }),
      'ira_rollin_opportunity',
    ).outcome

    expect(outcome.kind).toBe('not_applicable')
  })

  it('asks rather than assuming the plan accepts a roll-in', () => {
    const outcome = rule(
      run({
        accounts: [
          account({ id: 'ira' }),
          account({ id: 'plan', isEmployerPlan: true, acceptsIraRollIns: null }),
        ],
      }),
      'ira_rollin_opportunity',
    ).outcome

    expect(outcome.kind).toBe('needs_answer')
  })
})

describe('mega-backdoor headroom', () => {
  const plan = (over: Partial<OpportunityAccount> = {}) =>
    account({ id: 'plan', isEmployerPlan: true, ...over })

  it('does not exist without both after-tax contributions and a way out', () => {
    /*
     * The gate the spec insists on. Describing a strategy somebody's plan does not offer is the
     * kind of confidently wrong statement this feature is built to avoid.
     */
    const outcome = rule(
      run({
        accounts: [
          plan({ allowsAfterTaxContributions: true, allowsInPlanRothConversion: false, allowsInServiceWithdrawal: false }),
        ],
      }),
      'mega_backdoor_headroom',
    ).outcome

    expect(outcome.kind).toBe('not_applicable')
  })

  it('asks before deciding either way', () => {
    const outcome = rule(run({ accounts: [plan()] }), 'mega_backdoor_headroom').outcome
    expect(outcome.kind).toBe('needs_answer')
  })

  it('waits on the statutory limit even when the plan allows it', () => {
    // Eligibility is a plan fact; the figure is law. Knowing the first does not supply the second.
    const outcome = rule(
      run({
        accounts: [
          plan({ allowsAfterTaxContributions: true, allowsInPlanRothConversion: true }),
        ],
      }),
      'mega_backdoor_headroom',
    ).outcome

    expect(outcome).toMatchObject({ kind: 'needs_reference' })
    if (outcome.kind !== 'needs_reference') return
    expect(outcome.missing).toContain('total_annual_additions_limit')
  })

  it('reports the limit once it is approved', () => {
    const outcome = rule(
      run({
        accounts: [
          plan({ allowsAfterTaxContributions: true, allowsInServiceWithdrawal: true }),
        ],
        reference: [
          verified('total_annual_additions_limit', 7_000_000n, 'cents'),
          verified('employee_deferral_limit', 2_350_000n, 'cents'),
        ],
      }),
      'mega_backdoor_headroom',
    ).outcome

    expect(outcome).toMatchObject({ kind: 'informational', amountCents: 7_000_000n })
  })
})

describe('reference-gated rules', () => {
  it('block on an unapproved figure rather than inventing one', () => {
    /*
     * The whole reason the reference gate exists. An unapproved limit is not a limit, and a rule
     * that filled one in from anywhere would produce a confident statement about real money.
     */
    const outcome = rule(run(), 'employee_deferral_limit').outcome

    expect(outcome).toMatchObject({ kind: 'needs_reference' })
    if (outcome.kind !== 'needs_reference') return
    expect(outcome.missing).toEqual(['employee_deferral_limit'])
  })

  it('report the figure once approved, and say what Beans still cannot see', () => {
    const outcome = rule(
      run({ reference: [verified('employee_deferral_limit', 2_350_000n, 'cents')] }),
      'employee_deferral_limit',
    ).outcome

    expect(outcome).toMatchObject({ kind: 'informational', amountCents: 2_350_000n })
    if (outcome.kind !== 'informational') return
    // Payroll deferrals never reach Beans, so no progress can be claimed against the limit.
    expect(outcome.detail).toMatch(/payroll/i)
  })

  it('do not accept a figure approved for a different year', () => {
    const outcome = rule(
      run({
        taxYear: YEAR + 1,
        reference: [verified('employee_deferral_limit', 2_350_000n, 'cents')],
      }),
      'employee_deferral_limit',
    ).outcome

    expect(outcome.kind).toBe('needs_reference')
  })
})

describe('what Beans cannot do', () => {
  it('says tax-loss harvesting needs cost basis, rather than omitting it', () => {
    /*
     * Present as a named gap rather than absent, so "why doesn't it mention harvesting" has an
     * answer on the screen instead of in somebody's head.
     */
    const outcome = rule(run(), 'tax_loss_harvesting').outcome

    expect(outcome).toMatchObject({ kind: 'unavailable' })
    if (outcome.kind !== 'unavailable') return
    expect(outcome.reason).toMatch(/cost basis/i)
  })

  it('does not claim an HSA is 0% invested when it cannot see holdings', () => {
    // Reporting zero for an account whose positions were never reported is a confident wrong
    // answer, not a conservative one.
    const outcome = rule(
      run({ accounts: [account({ taxTreatment: 'hsa' })] }),
      'hsa_invested_share',
    ).outcome

    expect(outcome.kind).toBe('unavailable')
  })

  it('leaves HSA rules out entirely when there is no HSA', () => {
    expect(rule(run(), 'hsa_invested_share').outcome.kind).toBe('not_applicable')
    expect(rule(run(), 'hsa_contribution').outcome.kind).toBe('not_applicable')
  })
})

describe('every rule', () => {
  it('links to an authority and never phrases itself as advice', () => {
    /*
     * The spec's ground rule, enforced rather than trusted: no output is phrased as a
     * recommendation. A mechanism describes what a thing is; "you should" describes what to do.
     */
    for (const entry of run({ accounts: [account()] })) {
      expect(entry.sourceUrl.startsWith('https://')).toBe(true)
      expect(entry.mechanism).not.toMatch(/\byou should\b|\bwe recommend\b|\bmake sure to\b/i)
      expect(entry.title).not.toMatch(/\byou should\b/i)
    }
  })

  it('always reaches a conclusion rather than returning nothing', () => {
    // A rule that silently produces no row is indistinguishable from one that does not exist.
    const results = run({ accounts: [account()] })
    expect(results).toHaveLength(7)
    expect(results.every((entry) => entry.outcome.kind.length > 0)).toBe(true)
  })
})
