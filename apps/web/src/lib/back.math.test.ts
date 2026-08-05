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

/**
 * The chain, which is the whole point of nesting rather than carrying one level.
 *
 * Portfolio → account → holding → back → account → back must land on the portfolio, in the view it
 * was left in. Carrying only the immediate parent loses exactly that: the screen you came *through*
 * is the one you least want to be dropped from.
 */
describe('carrying the whole path', () => {
  const PORTFOLIO: BackTarget = { href: '/portfolio?group=holding', label: 'Portfolio' }

  it('unwinds two levels back to where the walk started', () => {
    const toAccount = withReturn('/accounts/abc', PORTFOLIO)
    const account = resolveBackTarget(searchOf(toAccount), FALLBACK)
    expect(account).toEqual(PORTFOLIO)

    const toHolding = withReturn('/holdings/VWO', { href: toAccount, label: 'Brokerage' })
    const holding = resolveBackTarget(searchOf(toHolding), FALLBACK)
    expect(holding.label).toBe('Brokerage')

    // And the account it lands on still knows about the portfolio behind it.
    expect(resolveBackTarget(searchOf(holding.href), FALLBACK)).toEqual(PORTFOLIO)
  })

  it('keeps the grouped view rather than the portfolio default', () => {
    const toHolding = withReturn('/holdings/VWO', PORTFOLIO)
    expect(resolveBackTarget(searchOf(toHolding), FALLBACK).href).toBe('/portfolio?group=holding')
  })

  /** An ampersand in a name must not truncate the chain that follows it. */
  it('survives a label containing a query separator', () => {
    const link = withReturn('/holdings/VWO', { href: '/accounts/a', label: 'Stocks & Shares' })
    const target = resolveBackTarget(searchOf(link), FALLBACK)

    expect(target.label).toBe('Stocks & Shares')
    expect(target.href).toBe('/accounts/a')
  })

  /**
   * The bound. Nesting encodes each URL inside the next, so a long enough walk would produce a URL
   * a browser refuses — past the limit the ancestry is dropped and only the parent is kept.
   */
  it('stops growing once the link would get unreasonable', () => {
    let href = '/portfolio'
    for (let step = 0; step < 40; step += 1) {
      href = withReturn(step % 2 === 0 ? '/accounts/abc' : '/holdings/VWO', {
        href,
        label: 'Somewhere',
      })
    }

    expect(href.length).toBeLessThanOrEqual(1500)
    // Still a usable link, not a truncated one.
    expect(resolveBackTarget(searchOf(href), FALLBACK).href.startsWith('/')).toBe(true)
  })
})

function searchOf(href: string): string {
  const index = href.indexOf('?')
  return index === -1 ? '' : href.slice(index + 1)
}

describe('a link that already carries a query', () => {
  it('keeps it rather than appending a second question mark', () => {
    const link = withReturn('/portfolio?group=holding', { href: '/accounts/a', label: 'Brokerage' })

    expect(link.split('?')).toHaveLength(2)

    const params = new URLSearchParams(searchOf(link))
    expect(params.get('group')).toBe('holding')
    expect(params.get('from')).toBe('/accounts/a')
  })
})
