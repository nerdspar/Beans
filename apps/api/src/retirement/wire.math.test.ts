import { projectScenario, retirementSpending } from '@beans/shared'
import { describe, expect, it } from 'vitest'
import { moneyIn, moneyOut, serializeProjection, toMemberInput } from './wire.js'

/**
 * The wire boundary.
 *
 * The first test is the one that earns the file: it serializes a real forty-year projection and
 * asserts the result survives `JSON.stringify`. A single missed `bigint` throws
 * `TypeError: Do not know how to serialize a BigInt`, so the failure mode is a 500 on the
 * dashboard rather than a slightly wrong figure — and it would only appear once a household had a
 * complete enough plan to run one.
 *
 * Fixed years throughout (CLAUDE.md).
 */

/** A real projection, long enough to exercise every per-year field and both bucket kinds. */
function realProjection() {
  return projectScenario(
    {
      startYear: 2_026,
      endYear: 2_065,
      openingBuckets: [
        { treatment: 'taxable' as never, balanceCents: 200_000_00n },
        { treatment: 'traditional' as never, balanceCents: 400_000_00n },
        { treatment: 'hsa' as never, balanceCents: 30_000_00n },
      ],
      contributions: [{ treatment: 'traditional' as never, annualCents: 23_000_00n }],
      spending: retirementSpending({
        trailingByCategory: [{ categoryId: 'living', cents: -72_000_00n }],
        monthsObserved: 12,
        assumptions: [{ categoryId: 'living', treatment: 'continues' }],
      }),
      members: [
        {
          id: 'member-1',
          birthYear: 1_975,
          retirementYear: 2_040,
          socialSecurityClaimAge: 67,
          socialSecurityAnnualBenefitCents: 34_000_00n,
        },
      ],
      retirementEffectiveRateBasisPoints: 2_200,
    },
    {
      id: 'expected',
      name: 'Markets behave',
      preRetirementReturnBasisPoints: 500,
      postRetirementReturnBasisPoints: 350,
    },
  )
}

/** Walks a parsed structure and reports anything that is not JSON-safe. */
function findBigints(value: unknown, path = '$'): string[] {
  if (typeof value === 'bigint') return [path]
  if (Array.isArray(value)) return value.flatMap((item, i) => findBigints(item, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => findBigints(inner, `${path}.${key}`))
  }
  return []
}

describe('serializeProjection', () => {
  it('produces something JSON can actually serialize', () => {
    const wire = serializeProjection(realProjection())

    // The assertion that matters. JSON.stringify throws on BigInt rather than coercing it.
    expect(findBigints(wire)).toEqual([])
    expect(() => JSON.stringify(wire)).not.toThrow()
  })

  it('sends every money figure as a decimal string, never a JSON number', () => {
    /*
     * A JSON number is an IEEE-754 double and loses precision above 2^53. A forty-year projection
     * on a healthy portfolio gets within reach of that, and the failure is silent.
     */
    const wire = serializeProjection(realProjection())

    for (const key of ['terminalTotal', 'heldBack', 'gap'] as const) {
      expect(typeof wire[key]).toBe('string')
    }

    for (const year of wire.years) {
      for (const key of [
        'total',
        'spending',
        'socialSecurity',
        'portfolioNeed',
        'withdrawals',
        'tax',
        'contributions',
        'growth',
        'shortfall',
      ] as const) {
        expect(typeof year[key]).toBe('string')
      }
      for (const bucket of year.buckets) expect(typeof bucket.balance).toBe('string')
    }
  })

  it('keeps rates and years as numbers, so consumers do not parse them back', () => {
    const wire = serializeProjection(realProjection())

    expect(typeof wire.fundedRatioBasisPoints === 'number' || wire.fundedRatioBasisPoints === null)
      .toBe(true)
    expect(wire.years[0]?.year).toBe(2_026)
    expect(typeof wire.years[0]?.year).toBe('number')
    expect(typeof wire.years[0]?.retired).toBe('boolean')
  })

  it('preserves a negative amount’s sign', () => {
    // Spending is negative throughout this feature. A serializer that dropped the sign would make
    // the plan read as income.
    const wire = serializeProjection(realProjection())
    const retired = wire.years.find((year) => year.retired)

    expect(retired?.spending.startsWith('-')).toBe(true)
  })

  it('carries the declared gaps through to the client', () => {
    // The UI is obliged to state these beside the figures, so they have to arrive.
    const wire = serializeProjection(realProjection())

    expect(wire.notModelled).toContain('required_minimum_distributions')
    expect(wire.notModelled).toContain('social_security_taxation')
  })

  it('keeps every year, so the band can be drawn', () => {
    const wire = serializeProjection(realProjection())
    expect(wire.years).toHaveLength(40)
  })
})

describe('moneyOut', () => {
  it('leaves null as null rather than reporting zero', () => {
    // Unanswered is not zero. "Your Social Security benefit is $0.00" is a different statement from
    // "nobody has entered it yet", and only one of them is true.
    expect(moneyOut(null)).toBeNull()
    expect(moneyOut(0n)).toBe('0.00')
  })

  it('round-trips a negative amount', () => {
    expect(moneyOut(-72_000_00n)).toBe('-72000.00')
  })
})

describe('moneyIn', () => {
  it('tells absent, null and a value apart', () => {
    /*
     * Three outcomes, not two. Absent means leave it alone, null means clear it, a value means set
     * it — and a patch that cannot express the middle one silently refuses to clear a field.
     */
    expect(moneyIn(undefined)).toBeUndefined()
    expect(moneyIn(null)).toBeNull()
    expect(moneyIn('34000.00')).toBe(34_000_00n)
  })

  it('parses through the money parser rather than parseFloat', () => {
    // CLAUDE.md: never parseFloat on a money string. The parser is exact.
    expect(moneyIn('0.07')).toBe(7n)
    expect(moneyIn('-1234567.89')).toBe(-1_234_567_89n)
  })
})

describe('toMemberInput', () => {
  it('leaves a field alone when the patch omits it', () => {
    const input = toMemberInput({ displayName: 'Scott', birthYear: 1_975 })

    expect(input).toEqual({ displayName: 'Scott', birthYear: 1_975 })
    expect('socialSecurityClaimAge' in input).toBe(false)
    expect('lifeExpectancy' in input).toBe(false)
  })

  it('clears a field when the patch sends null', () => {
    /*
     * The distinction that matters, and the one `!== undefined` would get wrong. Clearing a claim
     * age is a real operation — it is how somebody says "I have not decided after all" — and the
     * projection counts no benefit for a null.
     */
    const input = toMemberInput({
      displayName: 'Scott',
      birthYear: 1_975,
      socialSecurityClaimAge: null,
      socialSecurityAnnualBenefit: null,
    })

    expect('socialSecurityClaimAge' in input).toBe(true)
    expect(input.socialSecurityClaimAge).toBeNull()
    expect(input.socialSecurityAnnualBenefitCents).toBeNull()
  })

  it('converts a benefit to cents', () => {
    const input = toMemberInput({
      displayName: 'Scott',
      birthYear: 1_975,
      socialSecurityAnnualBenefit: '34000.00',
      targetRetirementDate: '2040-06-01',
      lifeExpectancy: 92,
    })

    expect(input.socialSecurityAnnualBenefitCents).toBe(34_000_00n)
    expect(input.targetRetirementDate).toBe('2040-06-01')
    expect(input.lifeExpectancy).toBe(92)
  })
})
