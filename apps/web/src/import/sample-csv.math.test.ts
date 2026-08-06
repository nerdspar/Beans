import { findPreset, parseImportRow, guessMapping } from '@beans/shared'
import { describe, expect, it } from 'vitest'
import { sampleCsv, sampleCsvFilename } from './sample-csv.js'

/**
 * The example file has to actually import.
 *
 * An example that Beans itself would reject is worse than no example — somebody matching their
 * export against it would be matching against a broken target, and would conclude their own file
 * was the problem. So these run the sample through the same guesser and row parser a real upload
 * goes through, rather than asserting on the text.
 */

const signed = findPreset('empower')!
const debitCredit = findPreset('mint')!

/**
 * Naive on purpose: no quoted fields, no embedded newlines.
 *
 * The real parser lives in the API, and reaching for it here would be testing that instead. The
 * sample is deliberately simple enough that splitting on commas is faithful — and if it ever stops
 * being, this breaks, which is the correct outcome for a file meant to be readable by eye.
 */
function parseCsvForTest(text: string): { headers: string[]; rows: string[][] } {
  const [header, ...rest] = text.trim().split('\n')
  return {
    headers: (header ?? '').split(','),
    rows: rest.map((line) => line.split(',')),
  }
}

describe('sampleCsv', () => {
  it('is mapped correctly by the same guesser a real upload uses', () => {
    for (const preset of [signed, debitCredit]) {
      const csv = parseCsvForTest(sampleCsv(preset))
      const roles = guessMapping(csv.headers).map((column) => column.role)

      // Date and amount are the two the import cannot proceed without.
      expect(roles).toContain('date')
      expect(roles.some((role) => role === 'amount' || role === 'debit')).toBe(true)
    }
  })

  it('parses every row, with the signs the convention implies', () => {
    for (const preset of [signed, debitCredit]) {
      const csv = parseCsvForTest(sampleCsv(preset))
      const mapping = guessMapping(csv.headers)

      const parsed = csv.rows.map((cells) =>
        parseImportRow(cells, { mapping, preset, dateFormat: 'iso' }),
      )

      expect(parsed.every((result) => result.ok)).toBe(true)

      const amounts = parsed.flatMap((result) => (result.ok ? [result.row.amountCents] : []))
      // The paycheck is money in and the groceries are money out, under either convention — which
      // is the property that would break if debit and credit were filled the wrong way round.
      expect(amounts[0]).toBeGreaterThan(0n)
      expect(amounts[1]).toBeLessThan(0n)
    }
  })

  it('gives the two conventions different files and different names', () => {
    // A debit/credit sample that looked identical to a signed one would mean the preset selector
    // was doing nothing, which is exactly the confusion the sample exists to prevent.
    expect(sampleCsv(signed)).not.toBe(sampleCsv(debitCredit))
    expect(sampleCsvFilename(signed)).not.toBe(sampleCsvFilename(debitCredit))
  })

  it('uses fixed dates, so the file does not change with the clock', () => {
    const currentYear = new Date('2026-01-01T00:00:00Z').getUTCFullYear()
    for (const line of sampleCsv(signed).trim().split('\n').slice(1)) {
      expect(line.startsWith(`${currentYear}-`)).toBe(true)
    }
  })
})
