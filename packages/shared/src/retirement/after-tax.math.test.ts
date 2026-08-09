import { describe, expect, it } from 'vitest'
import { afterTaxEquivalent } from './after-tax.js'
import type { BucketBalance } from './buckets.js'

/**
 * What a balance is actually worth.
 *
 * The cases that matter are the ones where a reasonable-looking shortcut would be wrong: treating an
 * HSA as pre-tax, silently haircutting taxable balances for capital gains Beans cannot see, or
 * letting a negative bucket produce a tax refund.
 */

const bucket = (treatment: string, balanceCents: bigint): BucketBalance => ({
  treatment: treatment as never,
  balanceCents,
})

const at22 = { retirementEffectiveRateBasisPoints: 2_200n }

describe('afterTaxEquivalent', () => {
  it('taxes pre-tax money and leaves Roth alone', () => {
    const result = afterTaxEquivalent(
      [bucket('traditional', 1_000_000_00n), bucket('roth', 1_000_000_00n)],
      at22,
    )

    expect(result.nominalCents).toBe(2_000_000_00n)
    // 22% of the traditional million only.
    expect(result.deferredTaxCents).toBe(220_000_00n)
    expect(result.afterTaxCents).toBe(1_780_000_00n)
  })

  it('does not treat an HSA as pre-tax', () => {
    /*
     * Qualified medical withdrawals are tax-free, which is the entire point of the account. Taxing
     * it would understate it for the use it is held for — and the app would be telling somebody
     * their HSA is worth less than it is.
     */
    const result = afterTaxEquivalent([bucket('hsa', 100_000_00n)], at22)
    expect(result.deferredTaxCents).toBe(0n)
    expect(result.afterTaxCents).toBe(100_000_00n)
  })

  it('does not treat a 529 as pre-tax either', () => {
    const result = afterTaxEquivalent([bucket('education', 50_000_00n)], at22)
    expect(result.deferredTaxCents).toBe(0n)
  })

  it('takes taxable at face value and says that it is ignoring capital gains', () => {
    /*
     * Beans has no cost basis, so any haircut would be a guess dressed as arithmetic. The flag is
     * what lets the UI say so out loud instead of quietly shaving 15%.
     */
    const result = afterTaxEquivalent([bucket('taxable', 500_000_00n)], at22)

    expect(result.afterTaxCents).toBe(500_000_00n)
    expect(result.ignoresCapitalGains).toBe(true)
  })

  it('does not claim to ignore capital gains when there is no taxable money', () => {
    // The note only earns its place when it applies. Shown always, it becomes furniture.
    const result = afterTaxEquivalent(
      [bucket('traditional', 100_000_00n), bucket('roth', 100_000_00n)],
      at22,
    )
    expect(result.ignoresCapitalGains).toBe(false)
  })

  it('does not produce a refund from a negative pre-tax bucket', () => {
    // Not something an institution reports, but reachable through a bad anchor. "You are owed money
    // on your 401(k)" is not a sentence this app should ever produce.
    const result = afterTaxEquivalent([bucket('traditional', -10_000_00n)], at22)
    expect(result.deferredTaxCents).toBe(0n)
    expect(result.afterTaxCents).toBe(-10_000_00n)
  })

  it('is the plain sum when the assumed rate is zero', () => {
    const result = afterTaxEquivalent(
      [bucket('traditional', 100_000_00n), bucket('roth', 1_00n)],
      { retirementEffectiveRateBasisPoints: 0n },
    )
    expect(result.afterTaxCents).toBe(result.nominalCents)
  })

  it('reports zero for nothing at all, rather than guessing', () => {
    const result = afterTaxEquivalent([], at22)
    expect(result).toMatchObject({ nominalCents: 0n, afterTaxCents: 0n, deferredTaxCents: 0n })
  })
})
