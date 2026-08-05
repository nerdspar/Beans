import { describe, expect, it } from 'vitest'
import {
  formatShares,
  groupBySymbol,
  holdingMove,
  personalIndex,
  pricePerShare,
  sumShares,
  type GroupableHolding,
} from './holdings.js'

describe('pricePerShare', () => {
  it('divides a market value by its share count', () => {
    // 88.47 shares worth $13,076.75 — the reference screenshot's CDW row, which shows $147.81.
    expect(pricePerShare(1_307_675n, '88.47')).toBe(14_781n)
  })

  it('handles a whole share count', () => {
    expect(pricePerShare(1_498_125n, '255')).toBe(5875n)
  })

  it('rounds to the nearest cent rather than truncating', () => {
    expect(pricePerShare(1000n, '3')).toBe(333n)
    expect(pricePerShare(2000n, '3')).toBe(667n)
  })

  /**
   * Some cash positions report a value and no share count. A price of $0.00 would be a claim about
   * the position rather than an admission that nothing was said.
   */
  it('reports nothing when there is no share count', () => {
    expect(pricePerShare(1000n, null)).toBeNull()
  })

  it('reports nothing rather than dividing by zero', () => {
    expect(pricePerShare(1000n, '0')).toBeNull()
  })

  it('reports nothing when the share count is not a number', () => {
    expect(pricePerShare(1000n, 'n/a')).toBeNull()
    expect(pricePerShare(1000n, '')).toBeNull()
  })

  it('handles a short position without inverting the sign', () => {
    expect(pricePerShare(-100_000n, '-10')).toBe(10_000n)
  })
})

describe('holdingMove', () => {
  it('measures the difference between two observations', () => {
    const move = holdingMove(1_307_675n, 1_288_769n)
    expect(move?.changeCents).toBe(18_906n)
    expect(move?.fraction).toBeCloseTo(0.014670, 5)
  })

  it('reports a fall as readily as a rise', () => {
    const move = holdingMove(1_288_769n, 1_307_675n)
    expect(move?.changeCents).toBe(-18_906n)
    expect(move?.fraction).toBeLessThan(0)
  })

  it('reports a genuinely flat position as zero, not as nothing', () => {
    const move = holdingMove(1000n, 1000n)
    expect(move?.changeCents).toBe(0n)
    expect(move?.fraction).toBe(0)
  })

  /**
   * The one that would produce the worst number on the screen: a position bought since the last
   * observation has no prior value, and treating its absence as zero would report the entire
   * holding as a gain.
   */
  it('reports nothing for a position that did not exist before', () => {
    expect(holdingMove(1_307_675n, null)).toBeNull()
    expect(holdingMove(1_307_675n, undefined)).toBeNull()
  })

  it('declines a percentage against a zero opening rather than dividing by it', () => {
    const move = holdingMove(1000n, 0n)
    expect(move?.changeCents).toBe(1000n)
    expect(move?.fraction).toBeNull()
  })
})

describe('formatShares', () => {
  it('truncates a long fraction to two places', () => {
    expect(formatShares('262.834')).toBe('262.83')
    expect(formatShares('13.760104')).toBe('13.76')
  })

  /**
   * Truncated rather than rounded, deliberately: rounding up would print more shares than are held,
   * and overstating a position is the wrong direction to be wrong in.
   */
  it('never rounds up', () => {
    expect(formatShares('88.479')).toBe('88.47')
    expect(formatShares('0.999')).toBe('0.99')
  })

  it('drops a fraction that is only zeros', () => {
    expect(formatShares('255.00')).toBe('255')
    expect(formatShares('164.000')).toBe('164')
  })

  it('drops only the trailing zero, not a meaningful one', () => {
    expect(formatShares('58.70')).toBe('58.7')
    expect(formatShares('58.07')).toBe('58.07')
  })

  it('leaves a short count alone', () => {
    expect(formatShares('21.93')).toBe('21.93')
    expect(formatShares('7')).toBe('7')
  })

  it('keeps a short position negative', () => {
    expect(formatShares('-10.5678')).toBe('-10.56')
  })

  it('handles a leading decimal point', () => {
    expect(formatShares('.5')).toBe('0.5')
  })

  /** Some institutions put text where a count belongs. Passing it through beats printing NaN. */
  it('returns anything unparseable untouched', () => {
    expect(formatShares('n/a')).toBe('n/a')
    expect(formatShares('')).toBe('')
    expect(formatShares('1,234.5')).toBe('1,234.5')
  })
})

describe('sumShares', () => {
  it('adds counts held in different accounts', () => {
    expect(sumShares(['255', '164', '62'])).toBe('481')
  })

  /** The reason this is bigint and not float: 88.47 + 10.5 must not become 98.96999999999998. */
  it('adds fractional counts exactly', () => {
    expect(sumShares(['88.47', '10.5'])).toBe('98.97')
    expect(sumShares(['0.1', '0.2'])).toBe('0.3')
  })

  it('keeps precision a broker actually reports', () => {
    expect(sumShares(['13.760104', '1.000001'])).toBe('14.760105')
  })

  it('handles a single member', () => {
    expect(sumShares(['21.93'])).toBe('21.93')
  })

  /**
   * A partial sum is worse than none: one account reporting a count and another not would produce a
   * total that silently understates the position.
   */
  it('refuses to total a group where a member reported no count', () => {
    expect(sumShares(['255', null])).toBeNull()
    expect(sumShares([null, null])).toBeNull()
  })

  it('refuses to total a group where a count cannot be read', () => {
    expect(sumShares(['255', 'n/a'])).toBeNull()
  })

  it('reports nothing for an empty group', () => {
    expect(sumShares([])).toBeNull()
  })

  it('nets a short position against a long one', () => {
    expect(sumShares(['100', '-40.5'])).toBe('59.5')
  })
})

describe('groupBySymbol', () => {
  const holding = (over: Partial<GroupableHolding> = {}): GroupableHolding => ({
    symbol: 'VWO',
    description: 'Vanguard FTSE Emerging Markets',
    shares: '100',
    marketValueCents: 587_500n,
    previousMarketValueCents: 580_000n,
    ...over,
  })

  it('collapses the same symbol across accounts and sums it', () => {
    const grouped = groupBySymbol([
      holding({ shares: '255', marketValueCents: 1_498_125n, previousMarketValueCents: 1_480_000n }),
      holding({ shares: '164', marketValueCents: 963_500n, previousMarketValueCents: 950_000n }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.marketValueCents).toBe(2_461_625n)
    expect(grouped[0]?.previousMarketValueCents).toBe(2_430_000n)
    expect(grouped[0]?.shares).toBe('419')
    expect(grouped[0]?.accountCount).toBe(2)
  })

  /** Institutions write the same fund differently; the symbol is the only reliable identity. */
  it('groups on the symbol even when descriptions differ', () => {
    const grouped = groupBySymbol([
      holding({ description: 'Vanguard FTSE Emerging Markets' }),
      holding({ description: 'VANGUARD FTSE EMERG MKT ETF' }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.accountCount).toBe(2)
  })

  it('is not confused by case in the symbol', () => {
    const grouped = groupBySymbol([holding({ symbol: 'vwo' }), holding({ symbol: 'VWO' })])
    expect(grouped).toHaveLength(1)
  })

  it('keeps different securities apart', () => {
    const grouped = groupBySymbol([
      holding({ symbol: 'VWO', marketValueCents: 100n }),
      holding({ symbol: 'CDW', marketValueCents: 200n }),
    ])
    expect(grouped.map((group) => group.symbol)).toEqual(['CDW', 'VWO'])
  })

  it('orders by value, largest first', () => {
    const grouped = groupBySymbol([
      holding({ symbol: 'A', marketValueCents: 100n }),
      holding({ symbol: 'B', marketValueCents: 900n }),
      holding({ symbol: 'C', marketValueCents: 500n }),
    ])
    expect(grouped.map((group) => group.symbol)).toEqual(['B', 'C', 'A'])
  })

  /**
   * The subtle one. If one account is a day behind, totalling only the members that have a prior
   * value would compare part of the group against all of it — a plausible-looking wrong number.
   */
  it('declines a prior total when any member lacks one', () => {
    const grouped = groupBySymbol([
      holding({ previousMarketValueCents: 580_000n }),
      holding({ previousMarketValueCents: null }),
    ])

    expect(grouped[0]?.previousMarketValueCents).toBeNull()
    expect(grouped[0]?.marketValueCents).toBe(1_175_000n)
  })

  /** Unnamed cash sweeps must not all merge into one row. */
  it('falls back to the description when there is no symbol', () => {
    const grouped = groupBySymbol([
      holding({ symbol: null, description: 'Cash sweep' }),
      holding({ symbol: null, description: 'Money market' }),
    ])
    expect(grouped).toHaveLength(2)
  })

  it('drops a position that identifies itself with neither', () => {
    expect(groupBySymbol([holding({ symbol: null, description: null })])).toEqual([])
  })

  it('returns nothing for no holdings', () => {
    expect(groupBySymbol([])).toEqual([])
  })
})

describe('personalIndex', () => {
  const at = (date: string, value: bigint) => ({ date, value })
  const noFlows = new Map<string, bigint>()

  it('starts at zero on the first day', () => {
    const index = personalIndex([at('2026-08-03', 100_000n), at('2026-08-04', 100_000n)], noFlows)
    expect(index[0]).toEqual({ date: '2026-08-03', basisPoints: 0n })
  })

  it('reports a plain gain where nothing was paid in', () => {
    const index = personalIndex([at('2026-08-03', 100_000n), at('2026-08-04', 102_000n)], noFlows)
    // 2% of the opening.
    expect(index[1]?.basisPoints).toBe(200n)
  })

  it('reports a fall as readily as a rise', () => {
    const index = personalIndex([at('2026-08-03', 100_000n), at('2026-08-04', 99_000n)], noFlows)
    expect(index[1]?.basisPoints).toBe(-100n)
  })

  /**
   * The whole reason this is not a percent-change chart. A deposit moves the balance and earns
   * nothing, and showing it as performance is the error this area keeps producing.
   */
  it('does not count a contribution as performance', () => {
    const index = personalIndex(
      [at('2026-08-03', 100_000n), at('2026-08-04', 150_000n)],
      new Map([['2026-08-04', 50_000n]]),
    )
    expect(index[1]?.basisPoints).toBe(0n)
  })

  it('separates the market from a contribution on the same day', () => {
    // Opened at 100,000, 50,000 paid in, closed at 153,000 — 3,000 earned on 150,000 exposed.
    const index = personalIndex(
      [at('2026-08-03', 100_000n), at('2026-08-04', 153_000n)],
      new Map([['2026-08-04', 50_000n]]),
    )
    expect(index[1]?.basisPoints).toBe(200n)
  })

  it('treats a withdrawal the same way', () => {
    const index = personalIndex(
      [at('2026-08-03', 100_000n), at('2026-08-04', 50_000n)],
      new Map([['2026-08-04', -50_000n]]),
    )
    expect(index[1]?.basisPoints).toBe(0n)
  })

  /** Chained, not summed: two 10% days are 21%, not 20%. */
  it('compounds returns rather than adding them', () => {
    const index = personalIndex(
      [at('2026-08-03', 100_000n), at('2026-08-04', 110_000n), at('2026-08-05', 121_000n)],
      noFlows,
    )
    expect(index[2]?.basisPoints).toBe(2100n)
  })

  it('holds flat across a day that did not move', () => {
    const index = personalIndex(
      [at('2026-08-03', 100_000n), at('2026-08-04', 102_000n), at('2026-08-05', 102_000n)],
      noFlows,
    )
    expect(index[1]?.basisPoints).toBe(200n)
    expect(index[2]?.basisPoints).toBe(200n)
  })

  /** Nothing was exposed, so nothing was earned — dividing would invent a return. */
  it('contributes no return for a day opening at zero', () => {
    const index = personalIndex([at('2026-08-03', 0n), at('2026-08-04', 10_000n)], noFlows)
    expect(index[1]?.basisPoints).toBe(0n)
  })

  it('recovers once there is something to earn on', () => {
    const index = personalIndex(
      [at('2026-08-03', 0n), at('2026-08-04', 10_000n), at('2026-08-05', 10_500n)],
      noFlows,
    )
    expect(index[2]?.basisPoints).toBe(500n)
  })

  it('has nothing to say about a single observation', () => {
    expect(personalIndex([at('2026-08-03', 100_000n)], noFlows)).toEqual([])
    expect(personalIndex([], noFlows)).toEqual([])
  })

  it('returns one point per day in the series', () => {
    const series = [
      at('2026-08-03', 100_000n),
      at('2026-08-04', 101_000n),
      at('2026-08-05', 102_000n),
    ]
    expect(personalIndex(series, noFlows).map((point) => point.date)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ])
  })
})
