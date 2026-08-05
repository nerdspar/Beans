import { describe, expect, it } from 'vitest'
import { formatShares, holdingMove, pricePerShare } from './holdings.js'

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
