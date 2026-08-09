import type { TaxTreatment } from '../accounts/classification.js'
import type { BucketBalance } from './buckets.js'

/**
 * What a balance is actually worth to you.
 *
 * A million dollars in a traditional 401(k) is not a million dollars, and almost no tool says so.
 * Pre-tax money is owed to the IRS at a rate nobody knows yet; Roth money is yours; taxable money
 * is yours minus a capital gains bill Beans cannot compute.
 *
 * **This is shown beside net worth, never instead of it.** Net worth is a fact — the sum of what the
 * institutions report. This is a fact plus an assumption, and the assumption travels with the number
 * wherever it appears. Replacing one with the other would trade something true for something
 * defensible, which is the wrong direction for the headline figure in a finance app.
 */

export type AfterTaxOptions = {
  /**
   * Assumed effective tax rate in retirement, in basis points. 2200 is 22%.
   *
   * An assumption, not a calculation. Beans knows what you hold and roughly what you spend; it does
   * not know future brackets, future law, or which state you will live in. The UI shows this rate
   * next to every figure it produces for exactly that reason.
   */
  retirementEffectiveRateBasisPoints: bigint
}

export type AfterTaxBreakdown = {
  /** The plain sum of the balances, matching net worth. */
  nominalCents: bigint
  /** What is left after the assumed tax on pre-tax money. */
  afterTaxCents: bigint
  /** The difference, which is the number worth showing: what is owed rather than owned. */
  deferredTaxCents: bigint
  /**
   * True when any balance is taxable, meaning the figure ignores embedded capital gains.
   *
   * Surfaced rather than silently corrected. Beans has no cost basis (§10.1 — holdings coverage is
   * thin and carries none), so any haircut here would be a guess dressed as arithmetic. Saying "this
   * ignores capital gains" is honest; quietly shaving 15% is not.
   */
  ignoresCapitalGains: boolean
}

/**
 * Which treatments carry a deferred tax bill.
 *
 * `traditional` is the pre-tax case. `hsa` is deliberately **not** here: qualified medical
 * withdrawals are tax-free, which is the entire point of the account, and treating it as pre-tax
 * would understate it for its intended use. `education` likewise — a 529 is tax-free for qualified
 * expenses. Both become taxable only on non-qualified withdrawal, which is a choice the holder has
 * not made and Beans should not assume for them.
 */
const DEFERRED: ReadonlySet<TaxTreatment> = new Set<TaxTreatment>(['traditional'])

/** Treatments whose value is reduced by unknown embedded gains rather than by a known tax. */
const HAS_EMBEDDED_GAINS: ReadonlySet<TaxTreatment> = new Set<TaxTreatment>(['taxable'])

export function afterTaxEquivalent(
  balances: readonly BucketBalance[],
  options: AfterTaxOptions,
): AfterTaxBreakdown {
  const rate = options.retirementEffectiveRateBasisPoints

  let nominalCents = 0n
  let deferredTaxCents = 0n
  let ignoresCapitalGains = false

  for (const balance of balances) {
    nominalCents += balance.balanceCents

    if (HAS_EMBEDDED_GAINS.has(balance.treatment) && balance.balanceCents !== 0n) {
      ignoresCapitalGains = true
    }

    if (!DEFERRED.has(balance.treatment)) continue

    /*
     * Only positive balances are taxed. A negative pre-tax balance is not a thing an institution
     * reports, but a bucket can arrive negative through a bad anchor — and "you are owed a refund on
     * your 401(k)" is not a sentence this app should ever produce.
     */
    if (balance.balanceCents <= 0n) continue

    const numerator = balance.balanceCents * rate
    // Rounded half up, once, on a single figure — no compounding here to drift.
    deferredTaxCents += (numerator + 5_000n) / 10_000n
  }

  return {
    nominalCents,
    afterTaxCents: nominalCents - deferredTaxCents,
    deferredTaxCents,
    ignoresCapitalGains,
  }
}
