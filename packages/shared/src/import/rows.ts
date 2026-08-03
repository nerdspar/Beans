import { parseDecimalToCents } from '../money/index.js'
import type { IsoDate } from '../balance-history/dates.js'
import type { ColumnMapping, ColumnRole, ImportPreset } from './mapping.js'

/**
 * Turning raw CSV cells into transactions.
 *
 * The two things that silently corrupt an import are handled explicitly here: **date format
 * ambiguity** and **amount sign convention**. Both produce a file that imports cleanly and is
 * wrong, which is far worse than one that fails.
 */

/**
 * How dates in a column are laid out.
 *
 * `ambiguous` is a real, common outcome — a column where every day happens to be 12 or lower
 * cannot be distinguished between US and European order. It is surfaced rather than guessed,
 * because guessing wrong shifts dates by up to eleven months while looking entirely plausible.
 */
export type DateFormat = 'iso' | 'month-first' | 'day-first' | 'ambiguous' | 'unrecognized'

const ISO = /^(\d{4})-(\d{2})-(\d{2})/
const SLASHED = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/

/**
 * Infers the date layout from a whole column rather than one value.
 *
 * A single `03/04/2026` is undecidable. A column containing `13/04/2026` somewhere is not — a first
 * component above 12 can only be a day. Reading the whole column is what makes most real files
 * decidable.
 */
export function detectDateFormat(samples: readonly string[]): DateFormat {
  let sawSlashed = false
  let firstExceedsTwelve = false
  let secondExceedsTwelve = false

  for (const sample of samples) {
    const value = sample.trim()
    if (value === '') continue

    if (ISO.test(value)) {
      return 'iso'
    }

    const match = SLASHED.exec(value)
    if (match === null) continue

    sawSlashed = true
    const first = Number(match[1])
    const second = Number(match[2])

    if (first > 12) firstExceedsTwelve = true
    if (second > 12) secondExceedsTwelve = true
  }

  if (!sawSlashed) {
    return 'unrecognized'
  }

  // Both positions exceeding 12 means the column is internally inconsistent — most likely two
  // formats mixed. Neither reading is safe.
  if (firstExceedsTwelve && secondExceedsTwelve) return 'ambiguous'
  if (firstExceedsTwelve) return 'day-first'
  if (secondExceedsTwelve) return 'month-first'

  return 'ambiguous'
}

export class RowParseError extends Error {
  override readonly name = 'RowParseError'
}

/**
 * Parses one cell into a calendar date.
 *
 * Never constructs a `Date` — string to string, so no timezone can shift the day. Two-digit years
 * map to 2000-2099, which is wrong for a 1997 statement but right for anything anyone will
 * plausibly import into a personal finance app.
 */
export function parseImportDate(value: string, format: DateFormat): IsoDate {
  const trimmed = value.trim()

  const iso = ISO.exec(trimmed)
  if (iso !== null) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`
  }

  const slashed = SLASHED.exec(trimmed)
  if (slashed === null) {
    throw new RowParseError(`Could not read ${JSON.stringify(value)} as a date`)
  }

  if (format === 'ambiguous' || format === 'unrecognized') {
    throw new RowParseError(
      'The date format in this column could not be determined. Choose it explicitly.',
    )
  }

  const first = Number(slashed[1])
  const second = Number(slashed[2])
  const rawYear = slashed[3] as string

  const [month, day] = format === 'day-first' ? [second, first] : [first, second]
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RowParseError(`${JSON.stringify(value)} is not a valid date`)
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export type ParsedRow = {
  date: IsoDate
  amountCents: bigint
  description: string
  payee: string | null
  memo: string | null
  category: string | null
  account: string | null
}

export type RowParseOptions = {
  mapping: readonly ColumnMapping[]
  preset: ImportPreset
  dateFormat: DateFormat
}

export type RowResult = { ok: true; row: ParsedRow } | { ok: false; reason: string }

function cell(
  cells: readonly string[],
  mapping: readonly ColumnMapping[],
  role: ColumnRole,
): string | null {
  const column = mapping.find((entry) => entry.role === role)
  if (column === undefined) return null
  return cells[column.columnIndex]?.trim() ?? null
}

/**
 * Strips accounting decoration before the strict money parser sees the value.
 *
 * Real exports contain `$1,234.56`, `(45.00)` for negatives, and stray spaces. The core parser
 * rejects all of that deliberately, so decoration is removed **here** and the number itself is
 * still parsed by the one strict implementation — rather than adding a second, looser parser that
 * would eventually disagree with the first.
 */
function normalizeAmount(raw: string): string {
  let value = raw.trim().replace(/[$£€\s]/g, '')

  // Accounting parentheses mean negative.
  const parenthesized = /^\((.*)\)$/.exec(value)
  if (parenthesized !== null) {
    value = `-${parenthesized[1] ?? ''}`
  }

  // A trailing minus, which some exports emit.
  const trailingMinus = /^(.*)-$/.exec(value)
  if (trailingMinus !== null) {
    value = `-${trailingMinus[1] ?? ''}`
  }

  return value
}

/**
 * Parses one CSV row.
 *
 * Returns a reason rather than throwing, because one malformed row in a five-year export must not
 * abort the import — it is staged as failed and shown alongside the rest.
 */
export function parseImportRow(cells: readonly string[], options: RowParseOptions): RowResult {
  const { mapping, preset, dateFormat } = options

  const rawDate = cell(cells, mapping, 'date')
  if (rawDate === null || rawDate === '') {
    return { ok: false, reason: 'No date' }
  }

  let date: IsoDate
  try {
    date = parseImportDate(rawDate, dateFormat)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Bad date' }
  }

  const amount = parseAmount(cells, mapping, preset)
  if (!amount.ok) {
    return amount
  }

  const description = cell(cells, mapping, 'description') ?? ''
  const payee = cell(cells, mapping, 'payee')

  if (description === '' && (payee === null || payee === '')) {
    return { ok: false, reason: 'No description or payee' }
  }

  return {
    ok: true,
    row: {
      date,
      amountCents: amount.amountCents,
      description: description === '' ? (payee ?? '') : description,
      payee: payee === '' ? null : payee,
      memo: emptyToNull(cell(cells, mapping, 'memo')),
      category: emptyToNull(cell(cells, mapping, 'category')),
      account: emptyToNull(cell(cells, mapping, 'account')),
    },
  }
}

type AmountResult = { ok: true; amountCents: bigint } | { ok: false; reason: string }

/**
 * Resolves the amount and its sign.
 *
 * Beans stores amounts signed so they add directly to net worth: spending negative, income
 * positive. Getting this backwards on an import flips every transaction in a five-year file, which
 * is why the convention is an explicit property of the preset rather than something inferred from
 * the data.
 */
function parseAmount(
  cells: readonly string[],
  mapping: readonly ColumnMapping[],
  preset: ImportPreset,
): AmountResult {
  if (preset.amountConvention === 'debit-credit') {
    const debit = cell(cells, mapping, 'debit')
    const credit = cell(cells, mapping, 'credit')

    const debitCents = parseOptional(debit)
    const creditCents = parseOptional(credit)

    if (debitCents === null && creditCents === null) {
      return { ok: false, reason: 'No amount in either the debit or credit column' }
    }
    if (debitCents !== null && creditCents !== null && debitCents !== 0n && creditCents !== 0n) {
      return { ok: false, reason: 'Both debit and credit are filled in' }
    }

    // Both columns carry positive magnitudes; the column decides direction.
    if (debitCents !== null && debitCents !== 0n) {
      return { ok: true, amountCents: -abs(debitCents) }
    }
    return { ok: true, amountCents: abs(creditCents ?? 0n) }
  }

  const raw = cell(cells, mapping, 'amount')
  if (raw === null || raw === '') {
    return { ok: false, reason: 'No amount' }
  }

  let cents: bigint
  try {
    cents = parseDecimalToCents(normalizeAmount(raw))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Bad amount' }
  }

  // Some exports treat a positive number as money spent. Explicit, because inferring it from the
  // data would mean guessing at the meaning of an entire file from its sign distribution.
  return { ok: true, amountCents: preset.amountConvention === 'inverted' ? -cents : cents }
}

function parseOptional(value: string | null): bigint | null {
  if (value === null || value.trim() === '') return null
  try {
    return parseDecimalToCents(normalizeAmount(value))
  } catch {
    return null
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function emptyToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value
}
