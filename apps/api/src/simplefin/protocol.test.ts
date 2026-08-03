import { describe, expect, it } from 'vitest'
import {
  SimplefinParseError,
  isConnectionAttentionError,
  isRateLimitError,
  parseAccountsResponse,
} from './protocol.js'

/**
 * Fixtures shaped like real Bridge responses — protocol v1, which is what the Bridge actually
 * serves. Tests never touch the network, so they neither depend on it nor consume the daily quota.
 */

const v1Response = {
  errors: [
    'Connection to Chase may need attention. Please visit https://beta-bridge.simplefin.org',
  ],
  accounts: [
    {
      org: {
        domain: 'www.fidelity.com',
        name: 'Fidelity Investments',
        'sfin-url': 'https://beta-bridge.simplefin.org/simplefin',
        url: 'https://www.fidelity.com',
        id: 'www.fidelity.com',
      },
      id: 'ACT-3f9a1c2e',
      name: 'Brokerage',
      currency: 'USD',
      balance: '322559.40',
      'available-balance': '0.00',
      'balance-date': 1_785_762_200,
      transactions: [
        {
          id: 'TRN-9d2e4a1b8c',
          posted: 1_785_675_800,
          amount: '5000.00',
          description: 'CHECK RECEIVED (Cash) Cash',
          payee: 'Check Received Cash',
          memo: '',
          transacted_at: 1_785_675_800,
        },
      ],
    },
    {
      org: { domain: 'www.chase.com', name: 'Chase', url: 'https://www.chase.com' },
      id: 'ACT-b81f0d44',
      name: 'Amazon Card',
      currency: 'USD',
      balance: '-3386.39',
      'available-balance': '8756.13',
      'balance-date': 1_785_762_300,
      transactions: [
        {
          id: 'TRN-4b6f8e0a11',
          posted: 0,
          amount: '-52.40',
          description: "TRADER JOE'S #452",
          transacted_at: 1_785_731_200,
          pending: true,
        },
      ],
    },
  ],
}

describe('parseAccountsResponse', () => {
  it('parses a v1 response', () => {
    const result = parseAccountsResponse(v1Response)

    expect(result.accounts).toHaveLength(2)
    expect(result.errors).toHaveLength(1)
  })

  it('converts amounts to exact integer cents, never through a float', () => {
    const [fidelity, chase] = parseAccountsResponse(v1Response).accounts

    expect(fidelity?.balanceCents).toBe(32255940n)
    expect(chase?.balanceCents).toBe(-338639n)
    expect(chase?.transactions[0]?.amountCents).toBe(-5240n)
  })

  it('reads hyphenated fields', () => {
    const [fidelity, chase] = parseAccountsResponse(v1Response).accounts

    expect(fidelity?.availableBalanceCents).toBe(0n)
    expect(chase?.availableBalanceCents).toBe(875613n)
    expect(fidelity?.balanceDate?.toISOString()).toBe('2026-08-03T13:03:20.000Z')
  })

  it('reads the nested org', () => {
    const [fidelity] = parseAccountsResponse(v1Response).accounts
    expect(fidelity?.org).toEqual({
      domain: 'www.fidelity.com',
      name: 'Fidelity Investments',
      url: 'https://www.fidelity.com',
    })
  })

  describe('pending transactions', () => {
    it('treats a zero posted timestamp as pending, falling back to transacted_at', () => {
      const [, chase] = parseAccountsResponse(v1Response).accounts
      const transaction = chase?.transactions[0]

      expect(transaction?.pending).toBe(true)
      // `posted` is 0 while pending, so the date has to come from transacted_at.
      expect(transaction?.date.toISOString()).toBe('2026-08-03T04:26:40.000Z')
    })

    it('treats the pending flag alone as pending', () => {
      // Some institutions set the flag but still send a real posted timestamp.
      const result = parseAccountsResponse({
        errors: [],
        accounts: [
          {
            id: 'A',
            balance: '10.00',
            transactions: [
              { id: 'T', posted: 1_785_675_800, amount: '-1.00', description: 'x', pending: true },
            ],
          },
        ],
      })

      expect(result.accounts[0]?.transactions[0]?.pending).toBe(true)
    })

    it('treats a normal posted transaction as not pending', () => {
      const [fidelity] = parseAccountsResponse(v1Response).accounts
      expect(fidelity?.transactions[0]?.pending).toBe(false)
    })
  })

  describe('tolerates the protocol v2 shape, which the Bridge does not serve yet', () => {
    it('reads errlist and top-level connections', () => {
      const result = parseAccountsResponse({
        errlist: [{ code: 'con.auth', msg: 'Reauthorize your Chase connection' }],
        connections: [{ id: 'CONN-1', domain: 'www.chase.com', name: 'Chase' }],
        accounts: [{ id: 'A', conn_id: 'CONN-1', name: 'Checking', balance: '100.00' }],
      })

      expect(result.errors).toEqual(['Reauthorize your Chase connection'])
      expect(result.accounts[0]?.org.name).toBe('Chase')
    })

    it('prefers an inline org when both are available', () => {
      const result = parseAccountsResponse({
        connections: [{ id: 'C', name: 'From connections' }],
        accounts: [{ id: 'A', conn_id: 'C', org: { name: 'From account' }, balance: '1.00' }],
      })

      expect(result.accounts[0]?.org.name).toBe('From account')
    })
  })

  describe('resilience', () => {
    it('drops a malformed transaction rather than losing the whole sync', () => {
      const result = parseAccountsResponse({
        errors: [],
        accounts: [
          {
            id: 'A',
            balance: '10.00',
            transactions: [
              { id: 'good', posted: 1_785_675_800, amount: '-1.00', description: 'ok' },
              { posted: 1_785_675_800, amount: '-2.00' }, // no id — cannot be deduplicated
              { id: 'no-amount', posted: 1_785_675_800 }, // no amount — cannot be counted
            ],
          },
        ],
      })

      expect(result.accounts[0]?.transactions.map((t) => t.id)).toEqual(['good'])
    })

    it('keeps an account that omits currency', () => {
      // At least one institution omits it. Left null rather than defaulting to USD, which would
      // assert something we were never told.
      const result = parseAccountsResponse({
        errors: [],
        accounts: [{ id: 'A', name: 'Chime', balance: '10.00' }],
      })

      expect(result.accounts[0]?.currency).toBeNull()
    })

    it('handles an account with no transactions array', () => {
      // What balances-only=1 returns.
      const result = parseAccountsResponse({
        errors: [],
        accounts: [{ id: 'A', balance: '10.00' }],
      })
      expect(result.accounts[0]?.transactions).toEqual([])
    })

    it('parses the unauthenticated error response the Bridge actually returns', () => {
      const result = parseAccountsResponse({ errors: ['No credentials provided'], accounts: [] })
      expect(result.accounts).toEqual([])
      expect(result.errors).toEqual(['No credentials provided'])
    })

    it('rejects a body that is not a SimpleFIN response at all', () => {
      // A proxy error page or a login redirect. Treating this as "no accounts" would look exactly
      // like every account having vanished.
      expect(() => parseAccountsResponse('<html>502 Bad Gateway</html>')).toThrow(
        SimplefinParseError,
      )
      expect(() => parseAccountsResponse({ message: 'unauthorized' })).toThrow(SimplefinParseError)
      expect(() => parseAccountsResponse(null)).toThrow(SimplefinParseError)
    })
  })

  it('does not normalize balance signs', () => {
    // Sign handling is a separate, deliberate step with a human in the loop. The parser reports
    // exactly what the provider said.
    const [, chase] = parseAccountsResponse(v1Response).accounts
    expect(chase?.balanceCents).toBe(-338639n)
  })
})

describe('error classification', () => {
  it('detects rate limiting, which arrives as prose rather than a 429', () => {
    expect(
      isRateLimitError([
        'Too many requests. SimpleFIN data is only refreshed once every 24 hours.',
      ]),
    ).toBe(true)
    expect(isRateLimitError(['Requested date range exceeds recommended range of 45 days.'])).toBe(
      true,
    )
    expect(isRateLimitError(['Connection to Chase may need attention'])).toBe(false)
  })

  it('detects a connection needing attention', () => {
    expect(isConnectionAttentionError('Connection to Chase may need attention')).toBe(true)
    expect(isConnectionAttentionError('We are upgrading this connection. Please wait...')).toBe(
      true,
    )
    expect(isConnectionAttentionError('No credentials provided')).toBe(false)
  })
})
