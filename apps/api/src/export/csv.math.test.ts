import { describe, expect, it } from 'vitest'
import { exportFilename, toCsv } from './csv.js'

/**
 * The quoting rules, because getting them wrong is silent.
 *
 * A field containing an unquoted comma does not fail to parse — it shifts every column after it by
 * one, for that row only. In an export of somebody's finances that is a balance landing in the date
 * column, in a file they are reading because they are leaving. There is no error to notice.
 */

describe('toCsv', () => {
  it('quotes a field containing a comma', () => {
    expect(toCsv(['a'], [['1,000.00']])).toBe('a\r\n"1,000.00"\r\n')
  })

  it('quotes and doubles an embedded quote', () => {
    // The one rule people implement wrong: escaping with a backslash, which CSV does not use.
    expect(toCsv(['a'], [['He said "hi"']])).toBe('a\r\n"He said ""hi"""\r\n')
  })

  it('quotes a field containing a newline', () => {
    // A memo with a line break in it would otherwise end the row early and start a bogus one.
    expect(toCsv(['a'], [['line one\nline two']])).toBe('a\r\n"line one\nline two"\r\n')
  })

  it('leaves ordinary fields unquoted, so the file reads plainly', () => {
    expect(toCsv(['date', 'amount'], [['2026-08-06', '-52.40']])).toBe(
      'date,amount\r\n2026-08-06,-52.40\r\n',
    )
  })

  it('writes a header even with no rows', () => {
    // An empty export must still say what it would have contained, or it reads as a failure.
    expect(toCsv(['date', 'amount'], [])).toBe('date,amount\r\n')
  })

  it('ends every line with CRLF, including the last', () => {
    const text = toCsv(['a'], [['1'], ['2']])
    expect(text).toBe('a\r\n1\r\n2\r\n')
    expect(text.endsWith('\r\n')).toBe(true)
  })
})

describe('exportFilename', () => {
  it('carries the date, so two exports are distinguishable', () => {
    expect(exportFilename('balances', '2026-08-06')).toBe('beans-balances-2026-08-06.csv')
  })
})
