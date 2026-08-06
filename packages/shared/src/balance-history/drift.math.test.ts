import { describe, expect, it } from 'vitest'
import { analyseDrift, type BalanceObservation, type DriftTransaction } from './drift.js'

/**
 * Detecting the failure the old check could not see.
 *
 * An institution reporting balances and transactions in opposite sign conventions produces a
 * smooth, plausible, steadily wrong chart. `checkReconstruction` compared the derived series to the
 * balance it was derived from, which is an invariant of the algorithm — it could only ever fail if
 * reconstruction were buggy.
 *
 * This works from two *independent* observations, which is what makes it capable of disagreeing at
 * all. The cases below are the ones that decide whether it is useful or merely loud: agreement must
 * stay silent, one bad period must stay silent, and a genuine inversion must be named rather than
 * reported as a large number.
 */

const observation = (date: string, cents: bigint): BalanceObservation => ({
  date: date as BalanceObservation['date'],
  balanceCents: cents,
})

const transaction = (date: string, cents: bigint): DriftTransaction => ({
  date: date as DriftTransaction['date'],
  amountCents: cents,
})

describe('analyseDrift', () => {
  it('is silent when the transactions explain the change exactly', () => {
    const result = analyseDrift(
      [observation('2026-01-01', 100_000n), observation('2026-02-01', 95_000n)],
      [transaction('2026-01-15', -5_000n)],
    )

    expect(result.intervals[0]?.driftCents).toBe(0n)
    expect(result.sustained).toBe(false)
  })

  it('ignores a transaction dated on the earlier reading, which is already inside it', () => {
    /*
     * The same off-by-one backward reconstruction guards against. Counting it twice manufactures
     * drift on an account that agrees perfectly — a false alarm on healthy data, which is the
     * fastest way to make a warning worth ignoring.
     */
    const result = analyseDrift(
      [observation('2026-01-01', 100_000n), observation('2026-02-01', 95_000n)],
      [transaction('2026-01-01', -1_000n), transaction('2026-01-15', -5_000n)],
    )
    expect(result.intervals[0]?.driftCents).toBe(0n)
  })

  it('stays silent for a single unexplained period', () => {
    // A provider missing one transaction is ordinary. Firing on it would train the reader to
    // dismiss the warning before it ever means anything.
    const result = analyseDrift(
      [
        observation('2026-01-01', 100_000n),
        observation('2026-02-01', 80_000n),
        observation('2026-03-01', 75_000n),
        observation('2026-04-01', 70_000n),
      ],
      [
        transaction('2026-01-15', -5_000n),
        transaction('2026-02-15', -5_000n),
        transaction('2026-03-15', -5_000n),
      ],
    )
    expect(result.sustained).toBe(false)
  })

  it('stays silent when drift alternates direction', () => {
    // Noise goes both ways. A sign convention error does not.
    const result = analyseDrift(
      [
        observation('2026-01-01', 100_000n),
        observation('2026-02-01', 96_000n),
        observation('2026-03-01', 90_000n),
        observation('2026-04-01', 86_000n),
      ],
      [
        transaction('2026-01-15', -5_000n),
        transaction('2026-02-15', -5_000n),
        transaction('2026-03-15', -5_000n),
      ],
    )
    expect(result.sustained).toBe(false)
  })

  it('fires on sustained same-direction drift', () => {
    const result = analyseDrift(
      [
        observation('2026-01-01', 100_000n),
        observation('2026-02-01', 97_000n),
        observation('2026-03-01', 94_000n),
        observation('2026-04-01', 91_000n),
      ],
      [
        transaction('2026-01-15', -5_000n),
        transaction('2026-02-15', -5_000n),
        transaction('2026-03-15', -5_000n),
      ],
    )

    expect(result.sustained).toBe(true)
    // Each period drifts +2_000; three of them.
    expect(result.cumulativeDriftCents).toBe(6_000n)
  })

  it('names inverted signs rather than just reporting a large number', () => {
    /*
     * The signature. Spending 5,000 a month with the signs inverted means Beans stores +5,000, so
     * the balance falls while the transactions claim it rose — drift of exactly twice the net, in
     * the same direction as the real movement, every single period.
     *
     * Worth naming because the remedy is a setting. A provider silently under-reporting drifts too,
     * and telling somebody to flip a sign switch for that would make their history worse.
     */
    const result = analyseDrift(
      [
        observation('2026-01-01', 100_000n),
        observation('2026-02-01', 95_000n),
        observation('2026-03-01', 90_000n),
        observation('2026-04-01', 85_000n),
      ],
      [
        transaction('2026-01-15', 5_000n),
        transaction('2026-02-15', 5_000n),
        transaction('2026-03-15', 5_000n),
      ],
    )

    expect(result.sustained).toBe(true)
    expect(result.likelyInverted).toBe(true)
    expect(result.intervals[0]?.driftCents).toBe(-10_000n)
  })

  it('does not claim inversion for drift that is merely persistent', () => {
    // A provider consistently missing a small recurring fee drifts the same way every month, which
    // is sustained and is not an inversion. Saying so would send somebody to flip a switch that
    // would double their problem.
    const result = analyseDrift(
      [
        observation('2026-01-01', 100_000n),
        // 200 a month unaccounted for — above the tolerance, and nothing like twice the net.
        observation('2026-02-01', 94_800n),
        observation('2026-03-01', 89_600n),
        observation('2026-04-01', 84_400n),
      ],
      [
        transaction('2026-01-15', -5_000n),
        transaction('2026-02-15', -5_000n),
        transaction('2026-03-15', -5_000n),
      ],
    )

    expect(result.sustained).toBe(true)
    expect(result.likelyInverted).toBe(false)
  })

  it('tolerates rounding rather than treating a cent as disagreement', () => {
    const result = analyseDrift(
      [
        observation('2026-01-01', 100_000n),
        observation('2026-02-01', 95_001n),
        observation('2026-03-01', 90_002n),
        observation('2026-04-01', 85_003n),
      ],
      [
        transaction('2026-01-15', -5_000n),
        transaction('2026-02-15', -5_000n),
        transaction('2026-03-15', -5_000n),
      ],
    )
    expect(result.sustained).toBe(false)
  })

  it('says nothing at all with fewer than two readings', () => {
    // A freshly connected account has one observation. There is no question to answer yet, and
    // guessing from a single reading is how a new account gets flagged on the day it arrives.
    expect(analyseDrift([observation('2026-01-01', 100_000n)], []).intervals).toHaveLength(0)
    expect(analyseDrift([], []).sustained).toBe(false)
  })

  it('sorts readings before comparing them', () => {
    const result = analyseDrift(
      [observation('2026-02-01', 95_000n), observation('2026-01-01', 100_000n)],
      [transaction('2026-01-15', -5_000n)],
    )
    expect(result.intervals[0]?.from).toBe('2026-01-01')
    expect(result.intervals[0]?.driftCents).toBe(0n)
  })
})
