import type { IsoDate } from '../balance-history/dates.js'
import { parseDecimalToCents } from '../money/index.js'
import type { ColumnMapping } from './mapping.js'
import type { DateFormat } from './rows.js'
import { cellFor, parseImportDate } from './rows.js'

/**
 * Reading a row of balance history.
 *
 * **This is the only route to investment history from before Beans was watching.** A cash balance
 * can be walked backwards from transactions — every change to it is a posting — so a transaction
 * import backfills that for free. An investment balance cannot: a share price moving is not
 * something anybody posts, so there is no arithmetic that recovers what a brokerage was worth in
 * 2019. A file of observed balances is the only thing that can say.
 *
 * Which is why the rows are so much simpler than a transaction's. A balance row is a *reading* —
 * this account was worth this much on this date — and it carries no direction, no payee, no
 * category, and no sign convention to get backwards. The one judgement it makes is the same one
 * every balance in Beans makes: liabilities are negative, and that decision was taken at the ingest
 * edge long before this file existed.
 */

export type ParsedBalanceRow = {
  date: IsoDate
  /** Signed cents, exactly as stored. A mortgage arrives negative and stays negative. */
  balanceCents: bigint
  /** The account named in the file, if it names one. Matched to a Beans account at staging. */
  account: string | null
}

export type BalanceRowResult =
  | { ok: true; row: ParsedBalanceRow }
  | { ok: false; reason: string }

export type BalanceRowParseOptions = {
  mapping: readonly ColumnMapping[]
  dateFormat: DateFormat
}

/**
 * Sparse rows are expected and fine.
 *
 * The realistic source is a statement per month, not a reading per day — the export that prompted
 * all of this hands over one month at a time. The gaps are filled by the same carry-forward the
 * rest of the history uses, so twelve rows a year gives a chart that starts in 2019 rather than one
 * that starts whenever the account was connected.
 */
export function parseBalanceRow(
  cells: readonly string[],
  options: BalanceRowParseOptions,
): BalanceRowResult {
  const { mapping, dateFormat } = options

  const rawDate = cellFor(cells, mapping, 'date')
  if (rawDate === null || rawDate === '') {
    return { ok: false, reason: 'No date' }
  }

  let date: IsoDate
  try {
    date = parseImportDate(rawDate, dateFormat)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Bad date' }
  }

  const rawBalance = cellFor(cells, mapping, 'balance')
  if (rawBalance === null || rawBalance === '') {
    return { ok: false, reason: 'No balance' }
  }

  let balanceCents: bigint
  try {
    /*
     * Through the money parser, which handles the currency symbols, thousands separators and
     * parenthesised negatives that real exports carry. Never `parseFloat`: a balance is the number
     * every chart and every total is built from, and losing a cent here is losing it everywhere.
     */
    balanceCents = parseDecimalToCents(normalizeBalance(rawBalance))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Bad balance' }
  }

  const account = cellFor(cells, mapping, 'account')

  return {
    ok: true,
    row: { date, balanceCents, account: account === '' ? null : account },
  }
}

/**
 * Strips the decoration exports put around a figure.
 *
 * `($1,234.56)` is accounting notation for negative and appears in real statement exports, which is
 * exactly where balance history comes from. Read as a positive it would turn a mortgage into an
 * asset — a quarter-million-dollar error in the direction nobody checks, because the number looks
 * plausible either way.
 */
function normalizeBalance(raw: string): string {
  const trimmed = raw.trim()
  const parenthesised = /^\((.*)\)$/.exec(trimmed)
  const inner = parenthesised?.[1] ?? trimmed
  const cleaned = inner.replace(/[$£€\s,]/g, '')
  return parenthesised === null ? cleaned : `-${cleaned.replace(/^-/, '')}`
}
