import { describe, expect, it } from 'vitest'
import { merchantKeyFor, merchantLabelFor } from './merchant.js'

/**
 * The same merchant must come out the same, month after month.
 *
 * Every fixture pair here is two charges a bank really would describe differently. If any pair
 * splits, that subscription silently never appears — there is no error, just a shorter list.
 */

const key = (description: string): string | null => merchantKeyFor(null, description)

describe('merchantKeyFor', () => {
  it('ignores the rotating phone number on a Netflix charge', () => {
    expect(key('NETFLIX.COM 866-579-7172 CA')).toBe('netflix.com')
    expect(key('NETFLIX.COM 866-716-0414 CA')).toBe('netflix.com')
  })

  it('strips a processor prefix, store number and date', () => {
    expect(key('SQ *BLUE BOTTLE 0423 OAKLAND CA 04/03')).toBe(
      key('SQ *BLUE BOTTLE 0511 OAKLAND CA 05/03'),
    )
    expect(key('SQ *BLUE BOTTLE 0423 OAKLAND CA 04/03')).toBe('blue bottle oakland')
  })

  it('strips the authorization date banks put in front', () => {
    expect(key('PURCHASE AUTHORIZED ON 03/14 SPOTIFY USA S582910341 NY CARD 4421')).toBe(
      key('PURCHASE AUTHORIZED ON 04/14 SPOTIFY USA S591177203 NY CARD 4421'),
    )
  })

  it('treats a reference code as noise', () => {
    expect(key('AMZN Prime*2K3L49QA2')).toBe(key('AMZN Prime*8H1M22ZB0'))
  })

  it('keeps the digits that are part of a name', () => {
    expect(key('1PASSWORD* 4X8E2K')).toBe('1password')
    expect(key('24 HOUR FITNESS USA 0882')).toBe('24 hour fitness usa')
  })

  it('reduces Apple billing to one merchant', () => {
    // Several subscriptions share this string; the detector separates them by amount.
    expect(key('APPLE.COM/BILL 866-712-7753 CA')).toBe('apple.com')
  })

  it('prefers the payee when the provider sends one', () => {
    expect(merchantKeyFor('Netflix', 'POS DEBIT 8823 NETFLIX.COM LOS GATOS CA')).toBe('netflix')
  })

  it('falls back to the description when the payee is blank', () => {
    expect(merchantKeyFor('  ', 'HULU 877-8244858 CA')).toBe('hulu')
  })

  it('returns null when nothing recognisable is left', () => {
    expect(key('POS 0423 04/03')).toBeNull()
    expect(merchantKeyFor(null, null)).toBeNull()
  })

  it('keeps a lone state-code-shaped name', () => {
    expect(key('CA')).toBe('ca')
  })
})

describe('merchantLabelFor', () => {
  it('shows the payee as sent', () => {
    expect(merchantLabelFor('Netflix', 'netflix')).toBe('Netflix')
  })

  it('title-cases the key when there is no payee', () => {
    expect(merchantLabelFor(null, 'blue bottle oakland')).toBe('Blue Bottle Oakland')
  })
})
