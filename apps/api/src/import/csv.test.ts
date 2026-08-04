import { describe, expect, it } from 'vitest'
import { distinctColumnValues, parseCsv } from './csv.js'

/**
 * Finding the accounts named inside an export.
 *
 * A whole-portfolio export names an institution and an account on every row. Collecting those
 * values is what lets each row be filed against the right account instead of all of them landing in
 * one — an import that otherwise succeeds completely and is completely wrong.
 */

/** Shaped after a real Empower export: dollar signs, quoted thousands, a trailing empty column. */
const EMPOWER = `Date,Description,Category,Institution,Account Name,Amount,Tags
2024-03-20,Amazon,General Merchandise,Chase,Amazon Card,-$27.60,
2026-07-21,Malden Catholic,Education,Bank of America,Rental Checking - Ending in 2155,-$122.17,
2026-07-20,Transfer,Transfers,Wealthfront,Joint Automated Investing Account,"$1,000.00",
2026-07-20,Joint Automated Investing Account,Transfers,Wealthfront,Joint Cash Account - Ending in 5497,"-$1,000.00",
2026-07-19,Whole Foods Market,Groceries,Chase,Amazon Card,-$77.94,
`

describe('distinctColumnValues', () => {
  const csv = parseCsv(EMPOWER)

  it('finds every account named in the file, without repeats', () => {
    expect(distinctColumnValues(csv.rows, 4)).toEqual([
      'Amazon Card',
      'Joint Automated Investing Account',
      'Joint Cash Account - Ending in 5497',
      'Rental Checking - Ending in 2155',
    ])
  })

  it('finds the institutions too, since either column may be the one to match on', () => {
    expect(distinctColumnValues(csv.rows, 3)).toEqual([
      'Bank of America',
      'Chase',
      'Wealthfront',
    ])
  })

  it('treats one account spelled two ways as one account', () => {
    const rows = [['AMAZON CARD'], ['Amazon Card'], ['amazon card']]
    // The first spelling seen is the one shown — the user should recognize their own file.
    expect(distinctColumnValues(rows, 0)).toEqual(['AMAZON CARD'])
  })

  it('ignores blank cells rather than offering an empty account to match', () => {
    expect(distinctColumnValues([['Chase'], [''], ['   '], ['Chase']], 0)).toEqual(['Chase'])
  })

  /**
   * The signal that a column is not categorical. A description column has thousands of distinct
   * values, and returning them all would put the whole file back over the wire it just came across.
   */
  it('returns null when a column has too many values to be a category', () => {
    const rows = Array.from({ length: 200 }, (_, index) => [`Payment ${index}`])
    expect(distinctColumnValues(rows, 0)).toBeNull()
  })

  it('returns the values when a column sits exactly at the limit', () => {
    const rows = Array.from({ length: 60 }, (_, index) => [`Account ${index}`])
    expect(distinctColumnValues(rows, 0, 60)).toHaveLength(60)
  })

  it('returns nothing for a column that does not exist', () => {
    expect(distinctColumnValues(csv.rows, 99)).toEqual([])
  })
})
