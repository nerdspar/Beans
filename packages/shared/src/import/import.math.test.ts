import { describe, expect, it } from 'vitest'
import {
  findPreset,
  guessMapping,
  hasBlockingProblem,
  validateMapping,
  type ColumnMapping,
} from './mapping.js'
import { detectDateFormat, parseImportDate, parseImportRow, RowParseError } from './rows.js'

const signed = findPreset('empower')!
const debitCredit = findPreset('mint')!

const mappingOf = (roles: ReadonlyArray<ColumnMapping['role']>): ColumnMapping[] =>
  roles.map((role, columnIndex) => ({ columnIndex, role }))

describe('column guessing', () => {
  it('maps a typical Empower header row', () => {
    const mapping = guessMapping(['Date', 'Description', 'Category', 'Amount', 'Account'])
    expect(mapping.map((c) => c.role)).toEqual([
      'date',
      'description',
      'category',
      'amount',
      'account',
    ])
  })

  it('is insensitive to case and punctuation', () => {
    const mapping = guessMapping(['TRANSACTION_DATE', 'transaction-amount', 'Details'])
    expect(mapping.map((c) => c.role)).toEqual(['date', 'amount', 'description'])
  })

  it('recognizes separate debit and credit columns', () => {
    const mapping = guessMapping(['Date', 'Description', 'Debit', 'Credit'])
    expect(mapping.map((c) => c.role)).toEqual(['date', 'description', 'debit', 'credit'])
  })

  it('assigns each role at most once', () => {
    // A file with both would otherwise end up with two date columns silently fighting.
    const mapping = guessMapping(['Date', 'Post Date', 'Amount'])
    expect(mapping.filter((c) => c.role === 'date')).toHaveLength(1)
    expect(mapping[0]?.role).toBe('date')
  })

  it('leaves unrecognized columns as an explicit ignore', () => {
    const mapping = guessMapping(['Date', 'Amount', 'Reference Number', 'Check #'])
    expect(mapping[2]?.role).toBe('ignore')
    expect(mapping[3]?.role).toBe('ignore')
  })

  it('handles a header row it recognizes nothing in', () => {
    // Still fully importable — the user maps it by hand.
    const mapping = guessMapping(['col1', 'col2'])
    expect(mapping.every((c) => c.role === 'ignore')).toBe(true)
  })
})

describe('mapping validation', () => {
  it('accepts a workable transaction mapping', () => {
    const problems = validateMapping(mappingOf(['date', 'description', 'amount']), 'transactions')
    expect(hasBlockingProblem(problems)).toBe(false)
  })

  it('requires a date column', () => {
    const problems = validateMapping(mappingOf(['description', 'amount']), 'transactions')
    expect(hasBlockingProblem(problems)).toBe(true)
    expect(problems[0]?.message).toMatch(/date column is required/)
  })

  /**
   * Without an amount every row would import as zero — silently, looking like a real import that
   * simply found nothing. That is worse than failing.
   */
  it('requires an amount, or debit and credit', () => {
    expect(
      hasBlockingProblem(validateMapping(mappingOf(['date', 'description']), 'transactions')),
    ).toBe(true)

    expect(
      hasBlockingProblem(
        validateMapping(mappingOf(['date', 'description', 'debit']), 'transactions'),
      ),
    ).toBe(false)
  })

  it('rejects both an amount column and debit/credit columns', () => {
    const problems = validateMapping(
      mappingOf(['date', 'amount', 'debit', 'credit']),
      'transactions',
    )
    expect(hasBlockingProblem(problems)).toBe(true)
  })

  it('rejects two columns mapped to the same role', () => {
    const problems = validateMapping(mappingOf(['date', 'amount', 'amount']), 'transactions')
    expect(hasBlockingProblem(problems)).toBe(true)
    expect(problems.some((p) => p.message.includes('amount'))).toBe(true)
  })

  it('warns rather than blocks on a missing description', () => {
    const problems = validateMapping(mappingOf(['date', 'amount']), 'transactions')
    expect(hasBlockingProblem(problems)).toBe(false)
    expect(problems[0]?.severity).toBe('warning')
  })

  it('requires a balance column for a balance import', () => {
    expect(hasBlockingProblem(validateMapping(mappingOf(['date']), 'balances'))).toBe(true)
    expect(hasBlockingProblem(validateMapping(mappingOf(['date', 'balance']), 'balances'))).toBe(
      false,
    )
  })
})

describe('date format detection', () => {
  it('recognizes ISO dates', () => {
    expect(detectDateFormat(['2026-08-03', '2026-08-04'])).toBe('iso')
  })

  /**
   * The whole column is read rather than one value, because a single `03/04/2026` is undecidable
   * and one `13/04/2026` anywhere in the file settles it.
   */
  it('uses the whole column to disambiguate', () => {
    expect(detectDateFormat(['03/04/2026', '13/04/2026'])).toBe('day-first')
    expect(detectDateFormat(['03/04/2026', '04/13/2026'])).toBe('month-first')
  })

  it('reports ambiguity rather than guessing', () => {
    // Every day is 12 or lower, so US and European order are indistinguishable. Guessing wrong
    // shifts dates by up to eleven months while looking entirely plausible.
    expect(detectDateFormat(['03/04/2026', '05/06/2026'])).toBe('ambiguous')
  })

  it('reports a column mixing both orders as ambiguous', () => {
    expect(detectDateFormat(['13/04/2026', '04/13/2026'])).toBe('ambiguous')
  })

  it('reports an unreadable column', () => {
    expect(detectDateFormat(['not a date', ''])).toBe('unrecognized')
  })

  it('ignores blank cells', () => {
    expect(detectDateFormat(['', '  ', '2026-08-03'])).toBe('iso')
  })
})

describe('date parsing', () => {
  it.each([
    ['2026-08-03', 'iso' as const, '2026-08-03'],
    ['08/03/2026', 'month-first' as const, '2026-08-03'],
    ['03/08/2026', 'day-first' as const, '2026-08-03'],
    ['8/3/2026', 'month-first' as const, '2026-08-03'],
    ['08/03/26', 'month-first' as const, '2026-08-03'],
  ])('parses %s as %s', (value, format, expected) => {
    expect(parseImportDate(value, format)).toBe(expected)
  })

  it('refuses to parse when the format is undetermined', () => {
    expect(() => parseImportDate('03/04/2026', 'ambiguous')).toThrow(RowParseError)
  })

  it('rejects an impossible date', () => {
    expect(() => parseImportDate('13/45/2026', 'month-first')).toThrow(RowParseError)
  })

  it('never passes through a local timezone', () => {
    // The same class of bug as node-postgres returning the previous day for date columns.
    expect(parseImportDate('2026-01-01', 'iso')).toBe('2026-01-01')
    expect(parseImportDate('12/31/2025', 'month-first')).toBe('2025-12-31')
  })
})

describe('row parsing', () => {
  const mapping = mappingOf(['date', 'description', 'amount', 'category'])
  const options = { mapping, preset: signed, dateFormat: 'month-first' as const }

  it('parses a signed row', () => {
    const result = parseImportRow(['08/01/2026', "TRADER JOE'S", '-52.40', 'Groceries'], options)

    expect(result).toEqual({
      ok: true,
      row: {
        date: '2026-08-01',
        amountCents: -5240n,
        description: "TRADER JOE'S",
        payee: null,
        memo: null,
        category: 'Groceries',
        account: null,
      },
    })
  })

  describe('accounting decoration', () => {
    it.each([
      ['$1,234.56', 123456n],
      ['(45.00)', -4500n],
      ['($1,234.56)', -123456n],
      ['  -52.40  ', -5240n],
      ['52.40-', -5240n],
      ['1,234.56', 123456n],
    ])('reads %s', (raw, expected) => {
      const result = parseImportRow(['08/01/2026', 'x', raw], {
        ...options,
        mapping: mappingOf(['date', 'description', 'amount']),
      })
      expect(result.ok && result.row.amountCents).toBe(expected)
    })

    it('still routes the number through the one strict money parser', () => {
      // Decoration is stripped here, but `1.2.3` is rejected by the same parser the rest of the app
      // uses — rather than a second, looser one that would eventually disagree.
      const result = parseImportRow(['08/01/2026', 'x', '$1.2.3'], {
        ...options,
        mapping: mappingOf(['date', 'description', 'amount']),
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('debit and credit columns', () => {
    const dcMapping = mappingOf(['date', 'description', 'debit', 'credit'])
    const dcOptions = {
      mapping: dcMapping,
      preset: debitCredit,
      dateFormat: 'month-first' as const,
    }

    it('reads a debit as spending', () => {
      const result = parseImportRow(['08/01/2026', 'Groceries', '52.40', ''], dcOptions)
      expect(result.ok && result.row.amountCents).toBe(-5240n)
    })

    it('reads a credit as income', () => {
      const result = parseImportRow(['08/01/2026', 'Paycheck', '', '1500.00'], dcOptions)
      expect(result.ok && result.row.amountCents).toBe(150000n)
    })

    it('takes the magnitude regardless of how the column signs it', () => {
      // Some exports put a negative in the debit column as well, which would otherwise double-negate.
      const result = parseImportRow(['08/01/2026', 'Groceries', '-52.40', ''], dcOptions)
      expect(result.ok && result.row.amountCents).toBe(-5240n)
    })

    it('rejects a row with both filled in', () => {
      const result = parseImportRow(['08/01/2026', 'x', '10.00', '20.00'], dcOptions)
      expect(result).toEqual({ ok: false, reason: 'Both debit and credit are filled in' })
    })

    it('rejects a row with neither', () => {
      const result = parseImportRow(['08/01/2026', 'x', '', ''], dcOptions)
      expect(result.ok).toBe(false)
    })
  })

  /**
   * An entire five-year file flipping sign is the worst outcome of an import, so the convention is
   * a property of the preset rather than something inferred from the data.
   */
  it('honors an inverted convention', () => {
    const inverted = { ...signed, amountConvention: 'inverted' as const }
    const result = parseImportRow(['08/01/2026', 'x', '52.40'], {
      mapping: mappingOf(['date', 'description', 'amount']),
      preset: inverted,
      dateFormat: 'month-first',
    })
    expect(result.ok && result.row.amountCents).toBe(-5240n)
  })

  describe('rejects rather than throws, so one bad row cannot abort an import', () => {
    it.each([
      ['no date', ['', 'x', '1.00']],
      ['bad date', ['not-a-date', 'x', '1.00']],
      ['no amount', ['08/01/2026', 'x', '']],
      ['bad amount', ['08/01/2026', 'x', 'abc']],
      ['no description or payee', ['08/01/2026', '', '1.00']],
    ])('rejects a row with %s', (_label, cells) => {
      const result = parseImportRow(cells, {
        ...options,
        mapping: mappingOf(['date', 'description', 'amount']),
      })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason.length).toBeGreaterThan(0)
    })
  })

  it('falls back to the payee when there is no description', () => {
    const result = parseImportRow(['08/01/2026', '', '-52.40', 'Trader Joes'], {
      mapping: mappingOf(['date', 'description', 'amount', 'payee']),
      preset: signed,
      dateFormat: 'month-first',
    })
    expect(result.ok && result.row.description).toBe('Trader Joes')
  })

  it('ignores columns mapped to ignore', () => {
    const result = parseImportRow(['08/01/2026', 'x', '-52.40', 'REF-99'], {
      mapping: mappingOf(['date', 'description', 'amount', 'ignore']),
      preset: signed,
      dateFormat: 'month-first',
    })
    expect(result.ok).toBe(true)
  })

  it('tolerates a short row', () => {
    // Trailing empty cells are frequently omitted entirely.
    const result = parseImportRow(['08/01/2026', 'x', '-52.40'], {
      mapping: mappingOf(['date', 'description', 'amount', 'category']),
      preset: signed,
      dateFormat: 'month-first',
    })
    expect(result.ok && result.row.category).toBeNull()
  })
})
