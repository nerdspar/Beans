import { describe, expect, it } from 'vitest'
import {
  PLACEHOLDER_VALUE,
  REFERENCE_DEFINITIONS,
  lookupReference,
  referenceReadiness,
  type ReferenceRow,
} from './reference.js'

/**
 * The gate that stops an unapproved statutory figure reaching a calculation.
 *
 * This is the most consequential test file in the retirement feature. Everything else here
 * produces a number that is wrong by an assumption somebody can see and argue with; this produces
 * a number that is wrong by law, confidently, about real money.
 *
 * Fixed years throughout (CLAUDE.md).
 */

const YEAR = 2_027

const row = (over: Partial<ReferenceRow> = {}): ReferenceRow => ({
  key: 'rmd_start_age',
  taxYear: YEAR,
  value: 73n,
  unit: 'years',
  sourceUrl: 'https://example.test/source',
  retrievedAt: new Date('2027-01-05T00:00:00.000Z'),
  verifiedAt: new Date('2027-01-05T00:00:00.000Z'),
  ...over,
})

describe('lookupReference', () => {
  it('returns a verified figure', () => {
    const result = lookupReference([row()], 'rmd_start_age', YEAR, 'years')

    expect(result).toEqual({
      status: 'ok',
      value: 73n,
      sourceUrl: 'https://example.test/source',
      taxYear: YEAR,
    })
  })

  it('refuses a figure nobody has approved', () => {
    /*
     * The gate. The row exists and carries a value; it is still not an answer, because nothing has
     * checked it against its source. Shipping placeholders is only safe because of this.
     */
    const result = lookupReference([row({ verifiedAt: null })], 'rmd_start_age', YEAR, 'years')

    expect(result.status).toBe('unverified')
  })

  it('never falls back to another year', () => {
    /*
     * Last year's limit is not this year's limit, and a silent fallback is indistinguishable from
     * a correct answer right up until somebody acts on it. The spec names this one explicitly.
     */
    const result = lookupReference([row({ taxYear: 2_026 })], 'rmd_start_age', YEAR, 'years')

    expect(result).toEqual({ status: 'missing', key: 'rmd_start_age', taxYear: YEAR })
  })

  it('reports a unit mismatch as a bug, not as a data gap', () => {
    /*
     * An age about to be read as cents. Calling it "unverified" would hide a programming error
     * behind a data-entry task that could never fix it — somebody would approve the row and the
     * bug would survive, now wearing a tick.
     */
    const result = lookupReference([row()], 'rmd_start_age', YEAR, 'cents')

    expect(result).toEqual({
      status: 'wrong_unit',
      key: 'rmd_start_age',
      expected: 'cents',
      actual: 'years',
    })
  })

  it('checks the unit before the approval gate', () => {
    // Same reasoning: a mismatched unit on an unapproved row is still a bug, and reporting it as
    // merely unapproved would send somebody to tick a box instead of to the code.
    const result = lookupReference(
      [row({ verifiedAt: null })],
      'rmd_start_age',
      YEAR,
      'cents',
    )

    expect(result.status).toBe('wrong_unit')
  })

  it('reports a missing key rather than returning zero', () => {
    const result = lookupReference([], 'employee_deferral_limit', YEAR, 'cents')
    expect(result).toEqual({ status: 'missing', key: 'employee_deferral_limit', taxYear: YEAR })
  })
})

describe('the placeholder value', () => {
  it('is absurd on purpose', () => {
    /*
     * A placeholder of 23500_00 looks checked, and the next person to read it has no way to know
     * it was invented — which is exactly the failure the reference-data rule exists to prevent.
     * One cent is self-evidently not a contribution limit, so if it ever escaped the gate it would
     * read as broken rather than as an answer.
     */
    expect(PLACEHOLDER_VALUE).toBe(1n)
  })
})

describe('referenceReadiness', () => {
  const verifiedAll = (): ReferenceRow[] =>
    REFERENCE_DEFINITIONS.map((definition) =>
      row({
        key: definition.key,
        unit: definition.unit,
        value: 5n,
        sourceUrl: definition.sourceUrl,
      }),
    )

  it('is ready only when every figure is approved', () => {
    expect(referenceReadiness(verifiedAll(), YEAR).ready).toBe(true)
  })

  it('is not ready when a single figure is still unapproved', () => {
    /*
     * One unapproved row is enough. A projection resting on thirteen checked figures and one
     * invented one is not thirteen-fourteenths right — it is wrong, and the banner says so.
     */
    const rows = verifiedAll()
    rows[3] = { ...rows[3]!, verifiedAt: null }

    const readiness = referenceReadiness(rows, YEAR)
    expect(readiness.ready).toBe(false)
    expect(readiness.unverified).toEqual([REFERENCE_DEFINITIONS[3]!.key])
  })

  it('reports an entirely empty year as every figure missing', () => {
    const readiness = referenceReadiness([], YEAR)

    expect(readiness.ready).toBe(false)
    expect(readiness.missing).toHaveLength(REFERENCE_DEFINITIONS.length)
    expect(readiness.unverified).toEqual([])
  })

  it('does not count another year’s approvals', () => {
    const readiness = referenceReadiness(
      verifiedAll().map((entry) => ({ ...entry, taxYear: 2_026 })),
      YEAR,
    )

    expect(readiness.ready).toBe(false)
  })
})

describe('the catalogue', () => {
  it('has no duplicate keys', () => {
    const keys = REFERENCE_DEFINITIONS.map((definition) => definition.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every figure a source to check it against', () => {
    // A figure with no source cannot be verified, only believed — which is the thing being
    // avoided. The URL is part of what a reviewer approves.
    for (const definition of REFERENCE_DEFINITIONS) {
      expect(definition.sourceUrl.startsWith('https://')).toBe(true)
      expect(definition.label.length).toBeGreaterThan(10)
    }
  })
})
