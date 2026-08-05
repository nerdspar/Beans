import { describe, expect, it } from 'vitest'
import { createPageUrl } from './client.js'

/**
 * Deriving the server's `/create` page from a stored access URL.
 *
 * The access URL is a credential — it carries basic-auth userinfo — and this produces a string that
 * is sent to the browser. Every case below is really one assertion: **nothing secret survives.**
 */
describe('createPageUrl', () => {
  it('points at the create page beneath the protocol root', () => {
    expect(createPageUrl('https://bridge.simplefin.org/simplefin')).toBe(
      'https://bridge.simplefin.org/simplefin/create',
    )
  })

  it('drops the credentials', () => {
    const url = createPageUrl('https://abc123:s3cret@bridge.simplefin.org/simplefin')

    expect(url).toBe('https://bridge.simplefin.org/simplefin/create')
    expect(url).not.toContain('abc123')
    expect(url).not.toContain('s3cret')
    expect(url).not.toContain('@')
  })

  it('drops a username with no password', () => {
    expect(createPageUrl('https://abc123@bridge.simplefin.org/simplefin')).toBe(
      'https://bridge.simplefin.org/simplefin/create',
    )
  })

  /** Credentials are percent-encoded in a real access URL; decoding must not resurrect them. */
  it('drops credentials that contain encoded characters', () => {
    const url = createPageUrl('https://user%40x:p%2Fss%3Aword@bridge.simplefin.org/simplefin')

    expect(url).toBe('https://bridge.simplefin.org/simplefin/create')
    expect(url).not.toContain('p%2Fss')
    expect(url).not.toContain('user%40x')
  })

  it('ignores any query or fragment on the stored URL', () => {
    expect(createPageUrl('https://u:p@bridge.simplefin.org/simplefin?x=1#frag')).toBe(
      'https://bridge.simplefin.org/simplefin/create',
    )
  })

  it('normalizes a trailing slash rather than doubling it', () => {
    expect(createPageUrl('https://u:p@bridge.simplefin.org/simplefin/')).toBe(
      'https://bridge.simplefin.org/simplefin/create',
    )
  })

  it('honours a self-hosted server on a non-standard port and path', () => {
    expect(createPageUrl('https://u:p@sfin.example.net:8443/api/v1')).toBe(
      'https://sfin.example.net:8443/api/v1/create',
    )
  })

  it('handles a root-path server', () => {
    expect(createPageUrl('https://u:p@bridge.example.com')).toBe(
      'https://bridge.example.com/create',
    )
  })

  /** Nothing partially scrubbed is ever returned — an unparseable URL yields nothing at all. */
  it('returns nothing rather than a guess when the URL will not parse', () => {
    expect(createPageUrl('not a url')).toBeNull()
    expect(createPageUrl('')).toBeNull()
  })
})
