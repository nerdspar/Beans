import { describe, expect, it, vi } from 'vitest'
import {
  MAX_WINDOW_DAYS,
  SetupTokenAlreadyClaimedError,
  SimplefinError,
  claimSetupToken,
  decodeSetupToken,
  fetchAccounts,
  parseAccessUrl,
  splitIntoWindows,
} from './client.js'
import { guessAccountType, suggestSignInversion, applySignConvention } from './account-type.js'

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-5F3309EC7028671B9987'
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64')
const ACCESS_URL = 'https://abc123:secret456@beta-bridge.simplefin.org/simplefin'

const respond = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

describe('setup token', () => {
  it('decodes to a claim URL', () => {
    expect(decodeSetupToken(SETUP_TOKEN)).toBe(CLAIM_URL)
  })

  it('tolerates the line wrapping the spec examples use', () => {
    const wrapped = `${SETUP_TOKEN.slice(0, 20)}\n  ${SETUP_TOKEN.slice(20)}\n`
    expect(decodeSetupToken(wrapped)).toBe(CLAIM_URL)
  })

  it.each([
    ['empty', ''],
    ['not base64 of a URL', Buffer.from('nonsense', 'utf8').toString('base64')],
    ['base64 of an http URL', Buffer.from('http://insecure.example', 'utf8').toString('base64')],
  ])('rejects a token that is %s', (_label, token) => {
    expect(() => decodeSetupToken(token)).toThrow(SimplefinError)
  })
})

describe('claiming a setup token', () => {
  it('returns the access URL from a plain-text response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(`${ACCESS_URL}\n`, { status: 200 }))

    expect(await claimSetupToken(SETUP_TOKEN, fetcher)).toBe(ACCESS_URL)

    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(CLAIM_URL)
    expect(init.method).toBe('POST')
    // Explicitly required — some stacks reject a bodyless POST without it.
    expect(init.headers['Content-Length']).toBe('0')
  })

  /**
   * Single-use is a protocol guarantee, so a repeat claim can never succeed. The spec also says to
   * treat it as a possible compromise signal, since it may mean somebody else claimed the token.
   */
  it('raises a distinct error on a token that was already claimed', async () => {
    // A fresh Response per call — a Response body can only be read once.
    const fetcher = vi
      .fn()
      .mockImplementation(async () => new Response('Forbidden', { status: 403 }))

    await expect(claimSetupToken(SETUP_TOKEN, fetcher)).rejects.toThrow(
      SetupTokenAlreadyClaimedError,
    )
    await expect(claimSetupToken(SETUP_TOKEN, fetcher)).rejects.toThrow(/compromised/)
  })

  it('detects the Forbidden body even on a 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 200 }))
    await expect(claimSetupToken(SETUP_TOKEN, fetcher)).rejects.toThrow(
      SetupTokenAlreadyClaimedError,
    )
  })

  it('rejects a response that is not an access URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"oops":true}', { status: 200 }))
    await expect(claimSetupToken(SETUP_TOKEN, fetcher)).rejects.toThrow(/not a valid access URL/)
  })

  it('makes exactly one request, never retrying a single-use token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(ACCESS_URL, { status: 200 }))
    await claimSetupToken(SETUP_TOKEN, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('access URL handling', () => {
  it('moves credentials into a Basic auth header', () => {
    const parsed = parseAccessUrl(ACCESS_URL)

    expect(parsed.origin).toBe('https://beta-bridge.simplefin.org')
    expect(parsed.path).toBe('/simplefin')
    expect(parsed.authorization).toBe(
      `Basic ${Buffer.from('abc123:secret456', 'utf8').toString('base64')}`,
    )
  })

  it('rejects a URL with no credentials', () => {
    expect(() => parseAccessUrl('https://beta-bridge.simplefin.org/simplefin')).toThrow(
      /no embedded credentials/,
    )
  })

  it('does not leave credentials in the request URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond('{"errors":[],"accounts":[]}'))
    await fetchAccounts(ACCESS_URL, fetcher)

    const [url] = fetcher.mock.calls[0]!
    expect(String(url)).not.toContain('secret456')
    expect(String(url)).toBe('https://beta-bridge.simplefin.org/simplefin/accounts')
  })
})

describe('fetching accounts', () => {
  it('sends dates as unix seconds, never ISO', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond('{"errors":[],"accounts":[]}'))

    await fetchAccounts(ACCESS_URL, fetcher, {
      startDate: new Date('2026-06-01T00:00:00.000Z'),
      endDate: new Date('2026-07-01T00:00:00.000Z'),
    })

    const url = new URL(String(fetcher.mock.calls[0]![0]))
    expect(url.searchParams.get('start-date')).toBe('1780272000')
    expect(url.searchParams.get('end-date')).toBe('1782864000')
  })

  it('opts in to pending transactions, which are off by default', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond('{"errors":[],"accounts":[]}'))
    await fetchAccounts(ACCESS_URL, fetcher, { includePending: true })

    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('pending')).toBe('1')
  })

  it('supports a balances-only refresh', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond('{"errors":[],"accounts":[]}'))
    await fetchAccounts(ACCESS_URL, fetcher, { balancesOnly: true })

    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('balances-only')).toBe('1')
  })

  it('omits parameters that were not asked for', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond('{"errors":[],"accounts":[]}'))
    await fetchAccounts(ACCESS_URL, fetcher)

    const params = new URL(String(fetcher.mock.calls[0]![0])).searchParams
    expect([...params.keys()]).toEqual([])
  })

  it('parses a 403 body rather than throwing, so the reason reaches the user', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(respond('{"errors":["Forbidden"],"accounts":[]}', 403))

    const result = await fetchAccounts(ACCESS_URL, fetcher)
    expect(result.errors).toEqual(['Forbidden'])
  })

  it('raises a clear error on a lapsed subscription', async () => {
    const fetcher = vi.fn().mockResolvedValue(respond('{}', 402))
    await expect(fetchAccounts(ACCESS_URL, fetcher)).rejects.toThrow(/subscription/)
  })

  it('raises on a non-JSON body, rather than reading it as no accounts', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }))
    await expect(fetchAccounts(ACCESS_URL, fetcher)).rejects.toThrow(/non-JSON/)
  })

  it('never retries on its own', async () => {
    // Retry policy lives in sync/quota.ts, where it can see the whole day's spend. A client that
    // retried locally would be invisible to that accounting.
    const fetcher = vi.fn().mockResolvedValue(respond('{"errors":[],"accounts":[]}'))
    await fetchAccounts(ACCESS_URL, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('date window chunking', () => {
  const day = (n: number): Date => new Date(Date.UTC(2026, 0, n))

  it('returns a single window inside the limit', () => {
    expect(splitIntoWindows(day(1), day(10))).toEqual([{ startDate: day(1), endDate: day(10) }])
  })

  it('splits a long range at the limit the live API enforces', () => {
    const windows = splitIntoWindows(
      new Date('2019-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    )

    expect(windows.length).toBeGreaterThan(50)
    for (const window of windows) {
      const days = (window.endDate.getTime() - window.startDate.getTime()) / (24 * 60 * 60 * 1000)
      expect(days).toBeLessThanOrEqual(MAX_WINDOW_DAYS)
    }
  })

  it('covers the range with no gaps', () => {
    const windows = splitIntoWindows(day(1), new Date(Date.UTC(2026, 5, 1)))

    expect(windows[0]?.startDate.toISOString()).toBe(day(1).toISOString())
    expect(windows.at(-1)?.endDate.toISOString()).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString())

    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index]?.startDate.toISOString()).toBe(
        windows[index - 1]?.endDate.toISOString(),
      )
    }
  })

  it('returns nothing for an inverted or empty range', () => {
    expect(splitIntoWindows(day(10), day(1))).toEqual([])
    expect(splitIntoWindows(day(1), day(1))).toEqual([])
  })

  /**
   * The specific failure this guards: an unset or zero start date produces a range spanning
   * decades, which can burn an entire day's request budget in one sync.
   */
  it('bounds an absurd range rather than issuing one enormous request', () => {
    const windows = splitIntoWindows(new Date(0), new Date('2026-01-01T00:00:00Z'))
    for (const window of windows) {
      const days = (window.endDate.getTime() - window.startDate.getTime()) / (24 * 60 * 60 * 1000)
      expect(days).toBeLessThanOrEqual(MAX_WINDOW_DAYS)
    }
  })
})

describe('account type inference', () => {
  it.each([
    ['Amazon Card', 'Chase', 'credit'],
    ['Marriott Bonvoy Brilliant American Express Card', null, 'credit'],
    ['Mortgage - Ending in 5653', 'NewRez', 'mortgage'],
    ['Conventional W/o Pmi', 'PennyMac Loan', 'loan'],
    ['Home Equity Line of Credit', null, 'loan'],
    ['Cdw Coworkers Profit Sharing Plan', 'Fidelity', 'investment'],
    ['Scott Roth IRA', 'Fidelity', 'investment'],
    ['Careforth 401(k) Plan', 'Transamerica', 'investment'],
    ['UTMA', 'Fidelity', 'investment'],
    ['Advantage Savings', 'Bank of America', 'depository'],
    ['Joint Checking', null, 'depository'],
  ] as const)('guesses %s as %s', (name, org, expected) => {
    expect(guessAccountType(name, org).type).toBe(expected)
  })

  it('orders rules so the specific beats the general', () => {
    // "Home Equity Line of Credit" contains "credit" but is a loan.
    expect(guessAccountType('Home Equity Line of Credit').type).toBe('loan')
    // "Mortgage Loan" contains "loan" but is a mortgage.
    expect(guessAccountType('Mortgage Loan Account').type).toBe('mortgage')
  })

  it('admits when it does not know, rather than guessing confidently', () => {
    // The real example from the reference screenshots — no heuristic can read this.
    const guess = guessAccountType('Adv Relationship Banking', 'Bank of America')
    expect(guess.confidence).toBe('low')
    expect(guess.basis).toMatch(/no recognizable keyword/)
  })

  it('explains its reasoning', () => {
    expect(guessAccountType('Scott Roth IRA').basis).toMatch(/retirement/)
  })
})

describe('sign inversion', () => {
  const highConfidenceCard = guessAccountType('Amazon Card', 'Chase')
  const highConfidenceChecking = guessAccountType('Joint Checking')

  it('suggests a flip for a card reported as a positive amount owed', () => {
    expect(suggestSignInversion(highConfidenceCard, 338639n)).toBe(true)
  })

  it('suggests no flip for a card already negative', () => {
    expect(suggestSignInversion(highConfidenceCard, -338639n)).toBe(false)
  })

  it('suggests nothing when the type guess is shaky', () => {
    // Compounding a shaky type guess with a sign guess produces a number that looks authoritative
    // and is not.
    const shaky = guessAccountType('Adv Relationship Banking')
    expect(suggestSignInversion(shaky, 338639n)).toBeNull()
  })

  it('suggests nothing for a zero balance, where sign carries no information', () => {
    expect(suggestSignInversion(highConfidenceCard, 0n)).toBeNull()
  })

  it('suggests nothing for a negative asset, since overdrafts are real', () => {
    expect(suggestSignInversion(highConfidenceChecking, -12300n)).toBeNull()
  })

  it('applies the stored convention in one place', () => {
    expect(applySignConvention(338639n, true)).toBe(-338639n)
    expect(applySignConvention(-338639n, false)).toBe(-338639n)
    expect(applySignConvention(0n, true)).toBe(0n)
  })

  it('round trips', () => {
    for (const cents of [0n, 1n, -1n, 338639n, -82487123n]) {
      expect(applySignConvention(applySignConvention(cents, true), true)).toBe(cents)
    }
  })
})
