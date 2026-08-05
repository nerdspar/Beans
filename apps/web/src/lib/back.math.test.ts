import { describe, expect, it } from 'vitest'
import { resolveBackTarget, withReturn, type BackTarget } from './back.js'

const FALLBACK: BackTarget = { href: '/portfolio', label: 'Portfolio' }

describe('withReturn', () => {
  it('carries the origin path and its label', () => {
    expect(withReturn('/holdings/VWO', { href: '/accounts/abc', label: 'Brokerage' })).toBe(
      '/holdings/VWO?from=%2Faccounts%2Fabc&fromLabel=Brokerage',
    )
  })

  it('encodes a label with spaces and punctuation', () => {
    const link = withReturn('/holdings/VWO', { href: '/accounts/a', label: 'ROTH IRA (3858)' })
    expect(resolveBackTarget(link.split('?')[1] ?? '', FALLBACK).label).toBe('ROTH IRA (3858)')
  })
})

describe('resolveBackTarget', () => {
  it('returns the encoded origin', () => {
    expect(resolveBackTarget('?from=%2Faccounts%2Fabc&fromLabel=Brokerage', FALLBACK)).toEqual({
      href: '/accounts/abc',
      label: 'Brokerage',
    })
  })

  it('falls back when nothing was encoded', () => {
    expect(resolveBackTarget('', FALLBACK)).toEqual(FALLBACK)
    expect(resolveBackTarget('?other=1', FALLBACK)).toEqual(FALLBACK)
  })

  it('keeps the fallback label when only a path was given', () => {
    expect(resolveBackTarget('?from=%2Faccounts%2Fabc', FALLBACK)).toEqual({
      href: '/accounts/abc',
      label: 'Portfolio',
    })
  })

  it('keeps the fallback label when the label is blank', () => {
    expect(resolveBackTarget('?from=%2Fa&fromLabel=%20%20', FALLBACK).label).toBe('Portfolio')
  })

  /**
   * The security case. This value arrives in a URL somebody can be sent, and it renders as the
   * app's own back control — so a link that made it point off-site would be wearing Beans' clothes.
   */
  it('refuses an absolute URL', () => {
    expect(resolveBackTarget('?from=https%3A%2F%2Fevil.example', FALLBACK)).toEqual(FALLBACK)
  })

  /** Protocol-relative: passes a naive "starts with /" check and still leaves the origin. */
  it('refuses a protocol-relative URL', () => {
    expect(resolveBackTarget('?from=%2F%2Fevil.example', FALLBACK)).toEqual(FALLBACK)
  })

  it('refuses a relative path that could escape', () => {
    expect(resolveBackTarget('?from=..%2F..%2Fetc', FALLBACK)).toEqual(FALLBACK)
  })

  it('refuses a javascript scheme', () => {
    expect(resolveBackTarget('?from=javascript%3Aalert(1)', FALLBACK)).toEqual(FALLBACK)
  })

  /** A chain unwinds one level at a time, which is what keeps two linked screens from circling. */
  it('carries only one level, so chains terminate', () => {
    const toHolding = withReturn('/holdings/VWO', { href: '/portfolio', label: 'Portfolio' })
    const toAccount = withReturn('/accounts/abc', { href: '/holdings/VWO', label: 'VWO' })

    expect(resolveBackTarget(toHolding.split('?')[1] ?? '', FALLBACK).href).toBe('/portfolio')
    expect(resolveBackTarget(toAccount.split('?')[1] ?? '', FALLBACK).href).toBe('/holdings/VWO')
  })
})
