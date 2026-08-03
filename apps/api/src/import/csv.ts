import Papa from 'papaparse'

/**
 * Reading a CSV file into rows.
 *
 * Tokenizing is delegated to papaparse — quoted fields containing delimiters, embedded newlines,
 * escaped quotes and CRLF are a large, well-understood set of edge cases that a hand-rolled parser
 * gets subtly wrong. What is *not* delegated is finding the header row, because real exports open
 * with preamble lines that no library knows to skip.
 */

export type ParsedCsv = {
  delimiter: string
  /** Index into the raw rows. Everything before it is preamble. */
  headerRowIndex: number
  headers: string[]
  /** Data rows, header excluded. */
  rows: string[][]
  /** Rows dropped for being blank. Reported so a row count discrepancy is explainable. */
  blankRowsSkipped: number
}

export class CsvParseError extends Error {
  override readonly name = 'CsvParseError'
}

/** Files routinely arrive with a UTF-8 BOM, which would otherwise corrupt the first header. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Parses a CSV file.
 *
 * Delimiter detection is papaparse's, which tries comma, tab, pipe and semicolon and picks the one
 * yielding the most consistent column count. Passing an explicit delimiter skips that entirely, for
 * a file it guesses wrong.
 */
export function parseCsv(content: string, delimiter?: string): ParsedCsv {
  const text = stripBom(content)

  if (text.trim() === '') {
    throw new CsvParseError('The file is empty')
  }

  const result = Papa.parse<string[]>(text, {
    // Header handling is ours — papaparse would take row 0, which is wrong for a file with
    // preamble.
    header: false,
    skipEmptyLines: 'greedy',
    ...(delimiter === undefined ? {} : { delimiter }),
  })

  const rawRows = result.data.filter((row) => Array.isArray(row))

  if (rawRows.length === 0) {
    throw new CsvParseError('The file contains no rows')
  }

  const detectedDelimiter = delimiter ?? result.meta.delimiter ?? ','
  const headerRowIndex = findHeaderRow(rawRows)
  const headers = (rawRows[headerRowIndex] ?? []).map((cell) => cell.trim())

  if (headers.length === 0) {
    throw new CsvParseError('Could not find a header row')
  }

  const body = rawRows.slice(headerRowIndex + 1)
  const rows = body.filter((row) => row.some((cell) => cell.trim() !== ''))

  return {
    delimiter: detectedDelimiter,
    headerRowIndex,
    headers,
    rows,
    blankRowsSkipped: body.length - rows.length,
  }
}

const NUMERIC = /^[$(\-+]?[\d,]+(\.\d+)?\)?$/
const DATE_LIKE = /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/

/**
 * Finds the row that is actually the header.
 *
 * Real exports open with a title, a date range, a blank line, or an account summary before the
 * real columns start. Taking row 0 on faith imports the preamble as a transaction and maps every
 * column wrong.
 *
 * The signal: a header row's cells are non-empty text that does not look like a date or a number,
 * and its width matches the width most data rows share. Falls back to row 0, which is right for the
 * common case and visible to the user either way — the mapping screen shows what was chosen.
 */
function findHeaderRow(rows: readonly string[][]): number {
  const modalWidth = findModalWidth(rows)

  // Only the opening rows are considered. A "header-like" row deep in the file is far more likely
  // to be data that happens to be textual.
  const limit = Math.min(rows.length, 20)

  for (let index = 0; index < limit; index += 1) {
    const row = rows[index]
    if (row === undefined || row.length !== modalWidth) continue

    const cells = row.map((cell) => cell.trim())
    if (cells.some((cell) => cell === '')) continue
    if (cells.some((cell) => NUMERIC.test(cell) || DATE_LIKE.test(cell))) continue

    return index
  }

  return 0
}

/** The column count most rows share, which data rows determine rather than preamble. */
function findModalWidth(rows: readonly string[][]): number {
  const counts = new Map<number, number>()

  for (const row of rows) {
    counts.set(row.length, (counts.get(row.length) ?? 0) + 1)
  }

  let modal = 0
  let best = 0
  for (const [width, count] of counts) {
    if (count > best || (count === best && width > modal)) {
      modal = width
      best = count
    }
  }

  return modal
}

/** Sample values from one column, for date-format detection. */
export function columnSamples(
  rows: readonly string[][],
  columnIndex: number,
  limit = 200,
): string[] {
  const samples: string[] = []

  for (const row of rows) {
    const value = row[columnIndex]
    if (value !== undefined && value.trim() !== '') {
      samples.push(value)
    }
    if (samples.length >= limit) break
  }

  return samples
}
