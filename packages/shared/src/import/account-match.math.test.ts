import { describe, expect, it } from 'vitest'
import { matchAccountsByMask, trailingDigits, type MatchableAccount } from './account-match.js'

const account = (id: string, mask: string | null, name = id): MatchableAccount => ({
  id,
  mask,
  name,
})

describe('trailingDigits', () => {
  it('takes the last four from an Empower-style name', () => {
    expect(trailingDigits('Scott Checking - Ending in 9224')).toBe('9224')
  })

  /**
   * Anchored to the end, not the first run found. `Group Id:ab - Ending in 99ab` has digits in the
   * middle, and pairing on those would match accounts on a fragment of an identifier.
   */
  it('ignores digits earlier in the name', () => {
    expect(trailingDigits('Group Id:20 - Ending in 4409')).toBe('4409')
  })

  it('tolerates trailing punctuation', () => {
    expect(trailingDigits('Checking (9224)')).toBe('9224')
    expect(trailingDigits('Checking 9224.')).toBe('9224')
  })

  it('takes only the last four of a longer number', () => {
    expect(trailingDigits('Card 4111111111111234')).toBe('1234')
  })

  it('reports nothing when there is no four-digit run at the end', () => {
    expect(trailingDigits('Family Credit Card')).toBeNull()
    expect(trailingDigits('Checking 224')).toBeNull()
    expect(trailingDigits('')).toBeNull()
  })
})

describe('matchAccountsByMask', () => {
  it('pairs a name to the one account with those four digits', () => {
    const matched = matchAccountsByMask(
      ['Scott Checking - Ending in 9224'],
      [account('checking', '9224'), account('savings', '4409')],
    )

    expect(matched).toEqual({ 'Scott Checking - Ending in 9224': 'checking' })
  })

  it('matches several names at once', () => {
    const matched = matchAccountsByMask(
      ['Checking - Ending in 9224', 'Savings - Ending in 4409'],
      [account('checking', '9224'), account('savings', '4409')],
    )

    expect(Object.keys(matched)).toHaveLength(2)
  })

  /**
   * The case where a guess is most dangerous: it looks handled, so nobody checks it again — and a
   * year of transactions lands on the wrong account silently.
   */
  it('leaves a name unmatched when two accounts share the digits', () => {
    const matched = matchAccountsByMask(
      ['Checking - Ending in 1234'],
      [account('a', '1234'), account('b', '1234')],
    )

    expect(matched).toEqual({})
  })

  it('leaves both unmatched when two names claim the same digits', () => {
    const matched = matchAccountsByMask(
      ['Checking - Ending in 1234', 'Savings - Ending in 1234'],
      [account('only', '1234')],
    )

    expect(matched).toEqual({})
  })

  it('ignores accounts the provider gave no mask for', () => {
    expect(matchAccountsByMask(['Card - Ending in 9224'], [account('a', null)])).toEqual({})
  })

  it('ignores names with nothing to match on', () => {
    expect(matchAccountsByMask(['Family Credit Card'], [account('a', '9224')])).toEqual({})
  })

  /** Never overwrites an answer somebody already gave. */
  it('leaves names the caller has already matched alone', () => {
    const matched = matchAccountsByMask(
      ['Checking - Ending in 9224'],
      [account('checking', '9224')],
      { 'Checking - Ending in 9224': 'chosen-by-hand' },
    )

    expect(matched).toEqual({})
  })

  /** A blank entry is not an answer — it is the unmatched default. */
  it('still matches a name whose existing entry is empty', () => {
    const matched = matchAccountsByMask(
      ['Checking - Ending in 9224'],
      [account('checking', '9224')],
      { 'Checking - Ending in 9224': '' },
    )

    expect(matched).toEqual({ 'Checking - Ending in 9224': 'checking' })
  })

  it('handles a mask stored with more than four characters', () => {
    const matched = matchAccountsByMask(
      ['Card - Ending in 1234'],
      [account('card', 'xxxx1234')],
    )

    expect(matched).toEqual({ 'Card - Ending in 1234': 'card' })
  })
})
