import type { ImportPreset } from '@beans/shared'

/**
 * A small example file, so somebody can see the shape before they go looking for an export.
 *
 * Generated rather than shipped as a static asset. It has to match the **selected preset**, and the
 * two conventions are genuinely different files: a signed export carries one `Amount` column where
 * a negative is money out, and a debit/credit export carries two and the sign is implied by which
 * one is filled. Handing a signed sample to somebody importing a Mint export would be teaching them
 * the wrong thing about their own data.
 *
 * Deliberately not a template to fill in. Beans reads what an app exported; it does not ask anyone
 * to type transactions into a spreadsheet. The rows are recognisable everyday ones so the columns
 * explain themselves, and there are enough of them to show a repeated account name.
 */

/** Columns the mapper recognises by name, so a sample imports without touching the mapping. */
const SIGNED_HEADER = 'Date,Description,Category,Account Name,Amount'
const DEBIT_CREDIT_HEADER = 'Date,Description,Category,Account Name,Debit,Credit'

/**
 * Fixed dates, never `new Date()`.
 *
 * A sample whose dates move with the clock is a sample that reads differently every time it is
 * downloaded, and dating rows in the future would demonstrate a thing Beans treats as suspect.
 */
const ROWS: ReadonlyArray<{
  date: string
  description: string
  category: string
  account: string
  /** Negative is money out, matching the domain convention everywhere else. */
  amount: string
}> = [
  { date: '2026-01-03', description: 'Paycheck', category: 'Salary', account: 'Everyday Checking', amount: '3250.00' },
  { date: '2026-01-04', description: "Trader Joe's", category: 'Groceries', account: 'Everyday Rewards Card', amount: '-86.42' },
  { date: '2026-01-06', description: 'Electric bill', category: 'Utilities', account: 'Everyday Checking', amount: '-142.18' },
  { date: '2026-01-09', description: 'Coffee', category: 'Restaurants', account: 'Everyday Rewards Card', amount: '-5.75' },
  { date: '2026-01-12', description: 'Card payment', category: 'Transfers', account: 'Everyday Checking', amount: '-250.00' },
]

function quote(value: string): string {
  // Only where it matters. Quoting everything would make the sample less readable than the exports
  // it stands in for, and the point is that somebody can open it and see the shape.
  return /[",]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function sampleCsv(preset: Pick<ImportPreset, 'amountConvention'>): string {
  const signed = preset.amountConvention === 'signed'

  const lines = ROWS.map((row) => {
    const cells = [row.date, row.description, row.category, row.account]

    if (signed) {
      cells.push(row.amount)
    } else {
      // Debit is money out, credit is money in, and exactly one is filled per row — which is the
      // whole distinction this convention exists to express.
      const negative = row.amount.startsWith('-')
      cells.push(negative ? row.amount.slice(1) : '', negative ? '' : row.amount)
    }

    return cells.map(quote).join(',')
  })

  return `${signed ? SIGNED_HEADER : DEBIT_CREDIT_HEADER}\n${lines.join('\n')}\n`
}

/** The filename the download lands under. Names the convention, since the two files differ. */
export function sampleCsvFilename(preset: Pick<ImportPreset, 'amountConvention'>): string {
  return preset.amountConvention === 'signed'
    ? 'beans-example-signed-amount.csv'
    : 'beans-example-debit-credit.csv'
}
