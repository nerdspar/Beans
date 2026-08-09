import { describe, expect, it } from 'vitest'
import { carryBucketsForward, type BucketAnchor, type ContributionRouting } from './buckets.js'

/**
 * Carrying a tax split forward.
 *
 * The case that matters, and the one the spec names: **a frozen bucket beside a contributing one
 * must shift ratio.** Growth alone preserves a ratio; contributions do not. Modelling the split as
 * a fixed percentage would be wrong in a way that compounds silently over a decade — the whole
 * reason this is carried forward rather than stored as a percentage.
 *
 * The other property worth pinning is that the parts sum to the account's real balance exactly. A
 * cent lost in a split is how a balance sheet stops balancing, and it would show up as an after-tax
 * figure that disagrees with net worth by an amount nobody can trace.
 */

const anchor = (asOfDate: string, buckets: Record<string, bigint>): BucketAnchor => ({
  asOfDate: asOfDate as BucketAnchor['asOfDate'],
  buckets: Object.entries(buckets).map(([treatment, balanceCents]) => ({
    treatment: treatment as never,
    balanceCents,
  })),
})

const route = (treatment: string, annualCents: bigint): ContributionRouting => ({
  treatment: treatment as never,
  annualCents,
})

const asOf = (date: string) => date as Parameters<typeof carryBucketsForward>[0]['asOf']

const by = (result: ReturnType<typeof carryBucketsForward>, treatment: string): bigint =>
  result.find((bucket) => bucket.treatment === treatment)?.balanceCents ?? 0n

describe('carryBucketsForward', () => {
  it('shifts the ratio when one bucket is frozen and another is contributed to', () => {
    /*
     * The spec's named case. A frozen traditional balance and an actively contributed Roth balance,
     * starting equal, over ten years. If the ratio comes back 50/50 the model is storing a
     * percentage rather than carrying anything forward.
     */
    const start = { traditional: 100_000_00n, roth: 100_000_00n }

    const result = carryBucketsForward({
      anchors: [anchor('2016-01-01', start)],
      routing: [route('roth', 20_000_00n)],
      annualReturnBasisPoints: 600n,
      asOf: asOf('2026-01-01'),
      // Whatever the account is really worth; the split is what is being tested.
      actualBalanceCents: 900_000_00n,
    })

    const traditional = by(result, 'traditional')
    const roth = by(result, 'roth')

    expect(roth).toBeGreaterThan(traditional)
    // Started equal. Anything near half means contributions were not modelled.
    expect(traditional * 2n).toBeLessThan(900_000_00n)
  })

  it('preserves the ratio when nothing is contributed, because growth is proportional', () => {
    // The control for the case above. Growth alone cannot move a ratio, so if this one shifts the
    // arithmetic is wrong rather than the model being clever.
    const result = carryBucketsForward({
      anchors: [anchor('2016-01-01', { traditional: 60_000_00n, roth: 40_000_00n })],
      routing: [],
      annualReturnBasisPoints: 700n,
      asOf: asOf('2026-01-01'),
      actualBalanceCents: 200_000_00n,
    })

    expect(by(result, 'traditional')).toBe(120_000_00n)
    expect(by(result, 'roth')).toBe(80_000_00n)
  })

  it('sums to the account’s real balance exactly, including the odd cent', () => {
    // Three buckets and a total that does not divide evenly. The remainder must land somewhere
    // rather than evaporating.
    const result = carryBucketsForward({
      anchors: [anchor('2025-01-01', { traditional: 1n, roth: 1n, taxable: 1n })],
      routing: [],
      annualReturnBasisPoints: 0n,
      asOf: asOf('2026-01-01'),
      actualBalanceCents: 100n,
    })

    expect(result.reduce((sum, bucket) => sum + bucket.balanceCents, 0n)).toBe(100n)
  })

  it('re-bases from the most recent anchor, discarding the model before it', () => {
    /*
     * Entering a fresh breakdown is the user saying the model was wrong. An older anchor plus ten
     * years of assumptions must not outvote a reading taken last month.
     */
    const result = carryBucketsForward({
      anchors: [
        anchor('2016-01-01', { traditional: 100_000_00n, roth: 0n }),
        anchor('2025-01-01', { traditional: 10_000_00n, roth: 90_000_00n }),
      ],
      routing: [],
      annualReturnBasisPoints: 500n,
      asOf: asOf('2026-01-01'),
      actualBalanceCents: 100_000_00n,
    })

    expect(by(result, 'roth')).toBe(90_000_00n)
    expect(by(result, 'traditional')).toBe(10_000_00n)
  })

  it('ignores an anchor dated after the date being asked about', () => {
    // A plan is not a time machine. Asking what the split was in 2020 must not use a 2026 reading.
    const result = carryBucketsForward({
      anchors: [
        anchor('2019-01-01', { traditional: 100_000_00n }),
        anchor('2026-01-01', { roth: 100_000_00n }),
      ],
      routing: [],
      annualReturnBasisPoints: 0n,
      asOf: asOf('2020-01-01'),
      actualBalanceCents: 50_000_00n,
    })

    expect(by(result, 'traditional')).toBe(50_000_00n)
    expect(by(result, 'roth')).toBe(0n)
  })

  it('returns nothing for an account nobody has broken out', () => {
    /*
     * No anchor means no known split. Guessing "probably all pre-tax" would produce a confident,
     * wrong after-tax figure — and the after-tax equivalent is the number this whole overlay exists
     * to make honest.
     */
    expect(
      carryBucketsForward({
        anchors: [],
        routing: [route('roth', 20_000_00n)],
        annualReturnBasisPoints: 600n,
        asOf: asOf('2026-01-01'),
        actualBalanceCents: 500_000_00n,
      }),
    ).toEqual([])
  })

  it('credits no contribution for a partial year', () => {
    // Annual figures, annual steps. Crediting eleven twelfths implies a monthly cadence the user
    // never stated, and understating is the safer direction for a retirement number.
    const result = carryBucketsForward({
      anchors: [anchor('2025-06-01', { traditional: 100_00n, roth: 0n })],
      routing: [route('roth', 50_00n)],
      annualReturnBasisPoints: 0n,
      asOf: asOf('2026-05-31'),
      actualBalanceCents: 100_00n,
    })

    expect(by(result, 'roth')).toBe(0n)
  })

  it('handles an anchor recorded entirely at zero without dividing by it', () => {
    // A brand new account, broken out before the first contribution landed. An even split is the
    // honest answer; a division error is not.
    const result = carryBucketsForward({
      anchors: [anchor('2026-01-01', { traditional: 0n, roth: 0n })],
      routing: [],
      annualReturnBasisPoints: 600n,
      asOf: asOf('2026-01-01'),
      actualBalanceCents: 0n,
    })

    expect(result).toHaveLength(2)
    expect(result.every((bucket) => bucket.balanceCents === 0n)).toBe(true)
  })

  it('never lets rounding drift the total across a decade of growth', () => {
    // Ten compounding steps on an awkward figure. The parts still have to sum to the real balance,
    // because the real balance is the one thing here that is not a model.
    const result = carryBucketsForward({
      anchors: [anchor('2016-03-15', { traditional: 33_333_33n, roth: 66_666_67n })],
      routing: [route('roth', 7_777_77n)],
      annualReturnBasisPoints: 637n,
      asOf: asOf('2026-03-15'),
      actualBalanceCents: 1_234_567_89n,
    })

    expect(result.reduce((sum, bucket) => sum + bucket.balanceCents, 0n)).toBe(1_234_567_89n)
  })
})
