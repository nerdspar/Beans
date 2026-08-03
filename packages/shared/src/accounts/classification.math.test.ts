import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_TYPES,
  NET_WORTH_SECTIONS,
  defaultTaxTreatment,
  isAsset,
  isLiability,
  isLiabilitySection,
  sectionForType,
  type AccountType,
} from './classification.js'
import { checkBalanceSign, checkBalanceSigns, hasBlockingAnomaly } from './sign.js'

describe('asset vs liability classification', () => {
  it.each<[AccountType, boolean]>([
    ['depository', true],
    ['investment', true],
    ['other_asset', true],
    ['credit', false],
    ['loan', false],
    ['mortgage', false],
    ['other_liability', false],
  ])('%s isAsset === %s', (type, expected) => {
    expect(isAsset(type)).toBe(expected)
    expect(isLiability(type)).toBe(!expected)
  })

  it('classifies every account type', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(typeof isAsset(type)).toBe('boolean')
      expect(NET_WORTH_SECTIONS).toContain(sectionForType(type))
    }
  })

  /**
   * The bug this exists to prevent: classifying by the sign of the balance rather than the account
   * type. An overdrawn checking account would silently jump into the liabilities bar, and the
   * assets/liabilities split would stop reconciling with net worth.
   */
  it('does not depend on the balance', () => {
    // Overdrawn checking: negative balance, still a cash asset.
    expect(isAsset('depository')).toBe(true)

    // A paid-off card: zero or positive balance, still a liability account.
    expect(isLiability('credit')).toBe(true)
  })

  it('maps types to the expected net worth sections', () => {
    expect(sectionForType('depository')).toBe('cash')
    expect(sectionForType('investment')).toBe('investment')
    expect(sectionForType('credit')).toBe('credit_card')
    expect(sectionForType('loan')).toBe('loan')
    expect(sectionForType('mortgage')).toBe('mortgage')
    expect(sectionForType('other_asset')).toBe('other_assets')
    expect(sectionForType('other_liability')).toBe('other_liabilities')
  })

  it('keeps loan and mortgage as separate sections', () => {
    // Empower folds loans under Mortgage; we keep them distinct and render only non-empty sections.
    expect(sectionForType('loan')).not.toBe(sectionForType('mortgage'))
  })

  it('agrees between type classification and section classification', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(isLiabilitySection(sectionForType(type))).toBe(isLiability(type))
    }
  })

  it('defaults tax treatment for every type', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(defaultTaxTreatment(type)).toBeTruthy()
    }
    expect(defaultTaxTreatment('investment')).toBe('taxable')
    expect(defaultTaxTreatment('depository')).toBe('none')
  })
})

describe('balance sign checks', () => {
  describe('liabilities must be negative', () => {
    it('blocks a positive mortgage — the doubled-net-worth bug', () => {
      const anomaly = checkBalanceSign('mortgage', 82487123n)
      expect(anomaly?.severity).toBe('blocking')
      expect(anomaly?.reason).toMatch(/reversed/)
    })

    it('blocks a positive loan', () => {
      expect(checkBalanceSign('loan', 1000n)?.severity).toBe('blocking')
    })

    it('accepts a negative mortgage', () => {
      expect(checkBalanceSign('mortgage', -82487123n)).toBeNull()
    })

    it('only warns on a positive card, since refunds are real', () => {
      const anomaly = checkBalanceSign('credit', 4523n)
      expect(anomaly?.severity).toBe('warning')
      expect(anomaly?.reason).toMatch(/refund|overpayment/)
    })

    it('accepts a normal card balance', () => {
      expect(checkBalanceSign('credit', -553583n)).toBeNull()
    })
  })

  describe('assets are normally positive', () => {
    it('warns rather than blocks on an overdraft, which is legitimate', () => {
      const anomaly = checkBalanceSign('depository', -12300n)
      expect(anomaly?.severity).toBe('warning')
      expect(anomaly?.reason).toMatch(/overdraft/)
    })

    it('blocks a negative investment balance', () => {
      expect(checkBalanceSign('investment', -1n)?.severity).toBe('blocking')
    })

    it('accepts normal positive balances', () => {
      expect(checkBalanceSign('depository', 54770n)).toBeNull()
      expect(checkBalanceSign('investment', 104202386n)).toBeNull()
      expect(checkBalanceSign('other_asset', 115780000n)).toBeNull()
    })
  })

  it('treats zero as unremarkable for every type', () => {
    // A paid-off card, a closed account, an unfunded IRA. Flagging these would train the user to
    // dismiss the warnings that matter.
    for (const type of ACCOUNT_TYPES) {
      expect(checkBalanceSign(type, 0n)).toBeNull()
    }
  })

  describe('across a discovered account set', () => {
    const accounts = [
      { id: 'a', type: 'depository' as const, balance: 54770n },
      { id: 'b', type: 'credit' as const, balance: 338639n }, // positive card: warning
      { id: 'c', type: 'mortgage' as const, balance: 47798062n }, // positive mortgage: blocking
      { id: 'd', type: 'investment' as const, balance: 32255940n },
    ]

    it('flags only the implausible ones', () => {
      const flagged = checkBalanceSigns(accounts)
      expect(flagged.map((f) => f.account.id)).toEqual(['c', 'b'])
    })

    it('sorts blocking first, so the worst number is read first', () => {
      expect(checkBalanceSigns(accounts)[0]?.anomaly.severity).toBe('blocking')
    })

    it('reports that confirmation must be blocked', () => {
      expect(hasBlockingAnomaly(checkBalanceSigns(accounts))).toBe(true)
    })

    it('allows confirmation when nothing is blocking', () => {
      const clean = [
        { id: 'a', type: 'depository' as const, balance: 54770n },
        { id: 'b', type: 'credit' as const, balance: -338639n },
      ]
      expect(checkBalanceSigns(clean)).toEqual([])
      expect(hasBlockingAnomaly(checkBalanceSigns(clean))).toBe(false)
    })
  })

  it('never modifies the amount it was given', () => {
    // Silently correcting a sign is how the error becomes invisible. This module reports only.
    const anomaly = checkBalanceSign('mortgage', 100n)
    expect(anomaly).not.toBeNull()
    expect(Object.keys(anomaly ?? {}).sort()).toEqual(['reason', 'severity'])
  })
})
