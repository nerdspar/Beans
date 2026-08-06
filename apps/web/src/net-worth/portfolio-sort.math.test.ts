import { describe, expect, it } from 'vitest'
import { sortAccounts, type SortableAccount } from './portfolio-sort.js'

/**
 * Ordering the portfolio.
 *
 * The cases worth pinning are the absent ones. An account that has never moved has no day change,
 * and one connected this morning has no percentage — treating either as zero would rank a brand
 * new account above a genuinely losing one, which reads as a claim about performance that nothing
 * in the data supports.
 */

const account = (overrides: Partial<SortableAccount> & { name: string }): SortableAccount => ({
  valueCents: 0n,
  changeCents: null,
  changeFraction: null,
  ...overrides,
})

const names = (list: readonly SortableAccount[]): string[] => list.map((entry) => entry.name)

describe('sortAccounts', () => {
  it('puts the largest balance first', () => {
    const sorted = sortAccounts(
      [
        account({ name: 'Small', valueCents: 1_000_00n }),
        account({ name: 'Large', valueCents: 500_000_00n }),
        account({ name: 'Middle', valueCents: 40_000_00n }),
      ],
      'balance',
    )
    expect(names(sorted)).toEqual(['Large', 'Middle', 'Small'])
  })

  it('compares balances as bigints rather than through Number', () => {
    /*
     * Two portfolios a cent apart, both above 2^53 cents. Subtracted into a Number they compare
     * equal and the sort silently returns whichever order it started in — wrong, with nothing to
     * indicate it.
     */
    const sorted = sortAccounts(
      [
        account({ name: 'Lower', valueCents: 90_071_992_547_409_91n }),
        account({ name: 'Higher', valueCents: 90_071_992_547_409_92n }),
      ],
      'balance',
    )
    expect(names(sorted)).toEqual(['Higher', 'Lower'])
  })

  it('puts the best day first, and a loss below a gain', () => {
    const sorted = sortAccounts(
      [
        account({ name: 'Down', changeCents: -5_000n }),
        account({ name: 'Up', changeCents: 12_000n }),
        account({ name: 'Flat', changeCents: 0n }),
      ],
      'change',
    )
    expect(names(sorted)).toEqual(['Up', 'Flat', 'Down'])
  })

  it('sorts accounts with no day change last, not as zero', () => {
    // The point. An account that has never moved is absent from the question, not flat — ranking it
    // level with a genuinely unchanged account would put it above every account that lost money.
    const sorted = sortAccounts(
      [
        account({ name: 'Never moved', changeCents: null }),
        account({ name: 'Lost', changeCents: -9_000n }),
        account({ name: 'Gained', changeCents: 400n }),
      ],
      'change',
    )
    expect(names(sorted)).toEqual(['Gained', 'Lost', 'Never moved'])
  })

  it('sorts a missing percentage last too', () => {
    const sorted = sortAccounts(
      [
        account({ name: 'No basis', changeFraction: null }),
        account({ name: 'Worse', changeFraction: -0.02 }),
        account({ name: 'Better', changeFraction: 0.01 }),
      ],
      'changePercent',
    )
    expect(names(sorted)).toEqual(['Better', 'Worse', 'No basis'])
  })

  it('breaks ties on name, so the order is stable rather than incidental', () => {
    // Two accounts at the same balance is not a corner case — it is two accounts holding nothing.
    const sorted = sortAccounts(
      [
        account({ name: 'Zebra', valueCents: 0n }),
        account({ name: 'Alpha', valueCents: 0n }),
      ],
      'balance',
    )
    expect(names(sorted)).toEqual(['Alpha', 'Zebra'])
  })

  it('does not mutate what it was given', () => {
    const input = [
      account({ name: 'B', valueCents: 1n }),
      account({ name: 'A', valueCents: 2n }),
    ]
    sortAccounts(input, 'balance')
    expect(names(input)).toEqual(['B', 'A'])
  })
})
