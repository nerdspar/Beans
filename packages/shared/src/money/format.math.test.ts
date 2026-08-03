import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { centsToDecimalString, formatCents } from './format.js'

describe('centsToDecimalString', () => {
  it.each([
    [0n, '0.00'],
    [1n, '0.01'],
    [10n, '0.10'],
    [100n, '1.00'],
    [1234n, '12.34'],
    [123456n, '1234.56'],
    [262001253n, '2620012.53'],
  ])('renders %s as %s', (cents, expected) => {
    expect(centsToDecimalString(cents)).toBe(expected)
  })

  it.each([
    [-1n, '-0.01'],
    [-10n, '-0.10'],
    [-100n, '-1.00'],
    [-1234n, '-12.34'],
    [-82487123n, '-824871.23'],
  ])('renders %s as %s', (cents, expected) => {
    expect(centsToDecimalString(cents)).toBe(expected)
  })

  it('always emits exactly two decimal places', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (cents) => {
        expect(centsToDecimalString(cents)).toMatch(/^-?\d+\.\d{2}$/)
      }),
      { numRuns: 1000 },
    )
  })

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    expect(centsToDecimalString(9007199254740993n)).toBe('90071992547409.93')
    expect(centsToDecimalString(9999999999999999999n)).toBe('99999999999999999.99')
  })
})

describe('formatCents', () => {
  it.each([
    [0n, '$0.00'],
    [1n, '$0.01'],
    [54770n, '$547.70'],
    [123456n, '$1,234.56'],
    [262001253n, '$2,620,012.53'],
  ])('formats %s as %s', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected)
  })

  it('formats negatives with a leading minus', () => {
    expect(formatCents(-82487123n)).toBe('-$824,871.23')
    expect(formatCents(-1n)).toBe('-$0.01')
  })

  it('can hide cents for compact display', () => {
    expect(formatCents(262001253n, { showCents: false })).toBe('$2,620,013')
  })

  it('can show an explicit plus, for deltas', () => {
    expect(formatCents(8905400n, { signDisplay: 'exceptZero' })).toBe('+$89,054.00')
    expect(formatCents(-1501800n, { signDisplay: 'exceptZero' })).toBe('-$15,018.00')
    expect(formatCents(0n, { signDisplay: 'exceptZero' })).toBe('$0.00')
  })

  it('honors a non-USD currency code', () => {
    expect(formatCents(123456n, { currency: 'EUR', locale: 'de-DE' })).toContain('€')
  })

  it('does not lose precision above Number.MAX_SAFE_INTEGER', () => {
    // Routing through a double would render this as ...409.92 or worse.
    expect(formatCents(9007199254740993n)).toBe('$90,071,992,547,409.93')
  })
})
