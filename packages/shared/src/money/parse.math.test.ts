import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MoneyParseError, parseDecimalToCents } from './parse.js'
import { centsToDecimalString } from './format.js'

describe('parseDecimalToCents', () => {
  describe('well-formed amounts', () => {
    it.each([
      ['0', 0n],
      ['0.00', 0n],
      ['1', 100n],
      ['1.00', 100n],
      ['1.5', 150n],
      ['1.50', 150n],
      ['0.01', 1n],
      ['0.1', 10n],
      ['12.34', 1234n],
      ['547.70', 54770n],
      ['2620012.53', 262001253n],
    ])('parses %s', (input, expected) => {
      expect(parseDecimalToCents(input)).toBe(expected)
    })
  })

  describe('negatives', () => {
    it.each([
      ['-0', 0n],
      ['-0.00', 0n],
      ['-1', -100n],
      ['-0.01', -1n],
      ['-12.34', -1234n],
      ['-824871.23', -82487123n],
    ])('parses %s', (input, expected) => {
      expect(parseDecimalToCents(input)).toBe(expected)
    })

    it('treats negative zero as zero', () => {
      // bigint has no -0, so this is exact rather than merely conventional.
      expect(parseDecimalToCents('-0.00')).toBe(0n)
      expect(Object.is(parseDecimalToCents('-0.00'), 0n)).toBe(true)
    })

    it('is symmetric with the positive form', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (cents) => {
          const decimal = centsToDecimalString(cents)
          expect(parseDecimalToCents(`-${decimal}`)).toBe(-parseDecimalToCents(decimal))
        }),
      )
    })

    it('accepts an explicit plus sign', () => {
      expect(parseDecimalToCents('+12.34')).toBe(1234n)
    })
  })

  describe('thousands separators', () => {
    it.each([
      ['1,234', 123400n],
      ['1,234.56', 123456n],
      ['12,345.67', 1234567n],
      ['123,456.78', 12345678n],
      ['1,234,567.89', 123456789n],
      ['-1,234.56', -123456n],
      ['3,450,419.00', 345041900n],
    ])('parses %s', (input, expected) => {
      expect(parseDecimalToCents(input)).toBe(expected)
    })

    it.each([
      '1,23', // group too short
      '1,2345', // group too long
      ',123', // leading separator
      '1,', // trailing separator
      '1234,567', // first group too long
      '1,,234',
      '1,5', // European decimal comma — must fail, not read as 15 dollars
    ])('rejects malformed grouping %s', (input) => {
      expect(() => parseDecimalToCents(input)).toThrow(MoneyParseError)
    })
  })

  describe('missing decimals', () => {
    it.each([
      ['5', 500n],
      ['100', 10000n],
      ['0', 0n],
      ['-7', -700n],
    ])('parses %s as whole units', (input, expected) => {
      expect(parseDecimalToCents(input)).toBe(expected)
    })

    it('parses a single decimal place as tenths', () => {
      expect(parseDecimalToCents('1.2')).toBe(120n)
      expect(parseDecimalToCents('1.9')).toBe(190n)
    })
  })

  describe('more than two decimal places — rounds half away from zero', () => {
    it.each([
      ['0.004', 0n],
      ['0.0049', 0n],
      ['0.005', 1n],
      ['0.0051', 1n],
      ['0.006', 1n],
      ['1.234', 123n],
      ['1.235', 124n],
      ['1.2349999', 123n],
    ])('rounds %s', (input, expected) => {
      expect(parseDecimalToCents(input)).toBe(expected)
    })

    it('rounds negatives away from zero, not toward it', () => {
      expect(parseDecimalToCents('-0.005')).toBe(-1n)
      expect(parseDecimalToCents('-1.235')).toBe(-124n)
      expect(parseDecimalToCents('-0.004')).toBe(0n)
    })

    it('carries correctly when rounding overflows the whole part', () => {
      expect(parseDecimalToCents('9.999')).toBe(1000n)
      expect(parseDecimalToCents('0.999')).toBe(100n)
      expect(parseDecimalToCents('-9.999')).toBe(-1000n)
      expect(parseDecimalToCents('999.999')).toBe(100000n)
    })

    it('handles many decimal places without float error', () => {
      expect(parseDecimalToCents('0.1234567890123456789')).toBe(12n)
      // 0.145 would round to 0.14 under float64 (it stores as 0.1449999...).
      expect(parseDecimalToCents('0.145')).toBe(15n)
    })
  })

  describe('whitespace', () => {
    it.each(['  12.34', '12.34  ', '\t12.34\n', ' 12.34 '])('trims %j', (input) => {
      expect(parseDecimalToCents(input)).toBe(1234n)
    })
  })

  describe('rejects malformed input', () => {
    it.each([
      ['', 'empty'],
      ['   ', 'whitespace only'],
      ['.', 'bare separator'],
      ['.50', 'no whole part'],
      ['1.', 'trailing separator'],
      ['1.2.3', 'two separators'],
      ['abc', 'letters'],
      ['12abc', 'trailing letters'],
      ['$12.34', 'currency symbol'],
      ['(12.34)', 'accounting negative'],
      ['12.34-', 'trailing sign'],
      ['--12.34', 'doubled sign'],
      ['+-12.34', 'mixed sign'],
      ['1 234.56', 'space separator'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['1e5', 'exponent notation'],
      ['0x10', 'hex'],
    ])('rejects %j (%s)', (input) => {
      expect(() => parseDecimalToCents(input)).toThrow(MoneyParseError)
    })

    it('rejects absurdly long input', () => {
      expect(() => parseDecimalToCents('1'.repeat(40))).toThrow(MoneyParseError)
    })

    it('includes the offending input in the message', () => {
      expect(() => parseDecimalToCents('$5')).toThrow(/\$5/)
    })
  })

  describe('never uses floating point', () => {
    it('is exact for values far beyond Number.MAX_SAFE_INTEGER', () => {
      // 2^53 cents is about $90 trillion. Well past any household, but the arithmetic must not
      // degrade — if this ever fails, a `number` has crept into the path.
      expect(parseDecimalToCents('99999999999999999.99')).toBe(9999999999999999999n)
      expect(parseDecimalToCents('90071992547409.93')).toBe(9007199254740993n)
    })

    it('distinguishes values that collide as float64', () => {
      expect(parseDecimalToCents('90071992547409.92')).not.toBe(
        parseDecimalToCents('90071992547409.93'),
      )
    })
  })

  describe('property: round trips through the decimal string form', () => {
    it('parse(format(cents)) === cents, for any cents', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (cents) => {
          expect(parseDecimalToCents(centsToDecimalString(cents))).toBe(cents)
        }),
        { numRuns: 1000 },
      )
    })

    it('never returns a non-bigint or throws on generated well-formed input', () => {
      const wellFormed = fc
        .tuple(
          fc.constantFrom('', '-', '+'),
          fc.bigInt({ min: 0n, max: 10n ** 12n }),
          fc.option(fc.stringMatching(/^\d{1,6}$/), { nil: undefined }),
        )
        .map(([sign, whole, fraction]) =>
          fraction === undefined ? `${sign}${whole}` : `${sign}${whole}.${fraction}`,
        )

      fc.assert(
        fc.property(wellFormed, (input) => {
          expect(typeof parseDecimalToCents(input)).toBe('bigint')
        }),
        { numRuns: 1000 },
      )
    })

    it('adding a thousands separator does not change the value', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 1000n, max: 10n ** 15n }), (whole) => {
          const plain = whole.toString()
          const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
          expect(parseDecimalToCents(grouped)).toBe(parseDecimalToCents(plain))
        }),
        { numRuns: 500 },
      )
    })
  })
})
