import { describe, expect, it } from 'vitest'
import { guessMapping } from './mapping.js'
import { parseBalanceRow } from './balance-rows.js'

/**
 * Reading balance history.
 *
 * The stakes differ from a transaction import in one specific way: a transaction read wrongly is
 * one wrong row among thousands, visible as a total that looks off. A **balance** read wrongly is
 * an anchor — every derived day around it is rebuilt from it — so a single misread row bends the
 * chart on both sides of itself and looks entirely plausible while doing it.
 *
 * The sign is the whole game. `($281,640.00)` is accounting notation for a debt and appears in real
 * statement exports, which is exactly where balance history comes from.
 */

const mapping = guessMapping(['Date', 'Account', 'Balance'])
const parse = (cells: readonly string[]) => parseBalanceRow(cells, { mapping, dateFormat: 'iso' })

describe('parseBalanceRow', () => {
  it('reads a plain reading', () => {
    const result = parse(['2019-03-01', 'Joint Brokerage', '142900.00'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.row.balanceCents).toBe(142_900_00n)
    expect(result.row.date).toBe('2019-03-01')
    expect(result.row.account).toBe('Joint Brokerage')
  })

  it('keeps a negative balance negative', () => {
    const result = parse(['2019-03-01', 'Home Mortgage', '-281640.00'])
    expect(result.ok && result.row.balanceCents).toBe(-281_640_00n)
  })

  it('reads parenthesised accounting notation as negative', () => {
    /*
     * The one that would be catastrophic and silent. Read as positive, a quarter-million-dollar
     * mortgage becomes a quarter-million-dollar asset — a half-million-dollar swing in net worth,
     * from a number that looks entirely reasonable in the file.
     */
    const result = parse(['2019-03-01', 'Home Mortgage', '($281,640.00)'])
    expect(result.ok && result.row.balanceCents).toBe(-281_640_00n)
  })

  it('strips currency symbols and thousands separators', () => {
    expect(parse(['2019-03-01', 'A', '$1,234.56']).ok).toBe(true)
    const result = parse(['2019-03-01', 'A', '$1,234.56'])
    expect(result.ok && result.row.balanceCents).toBe(1_234_56n)
  })

  it('refuses a row with no balance rather than reading it as zero', () => {
    // Zero is a balance. A blank is not knowing, and writing it as an anchor of 0 would rebuild
    // every surrounding day against a figure the file never claimed.
    const result = parse(['2019-03-01', 'A', ''])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('No balance')
  })

  it('refuses a row with no date', () => {
    const result = parse(['', 'A', '100.00'])
    expect(!result.ok && result.reason).toBe('No date')
  })

  it('refuses an unreadable balance rather than guessing', () => {
    expect(parse(['2019-03-01', 'A', 'n/a']).ok).toBe(false)
  })

  it('carries a null account when the file names none', () => {
    const noAccount = guessMapping(['Date', 'Balance'])
    const result = parseBalanceRow(['2019-03-01', '100.00'], {
      mapping: noAccount,
      dateFormat: 'iso',
    })
    // A single-account file is normal; the account is chosen once at staging instead.
    expect(result.ok && result.row.account).toBeNull()
  })
})
