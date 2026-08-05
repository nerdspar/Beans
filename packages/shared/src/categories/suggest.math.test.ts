import { describe, expect, it } from 'vitest'
import { merchantKey, suggestRules, type SuggestableTransaction } from './suggest.js'

const at = (over: Partial<SuggestableTransaction> = {}): SuggestableTransaction => ({
  payee: 'Amazon',
  description: 'AMZN Mktp US*2K4LM',
  amountCents: -4299n,
  categoryId: null,
  ...over,
})

describe('merchantKey', () => {
  /** The whole job: two visits to one shop must not look like two merchants. */
  it('collapses the reference noise that differs between visits', () => {
    expect(merchantKey(at({ payee: 'AMZN Mktp US*2K4LM' }))).toBe(
      merchantKey(at({ payee: 'AMZN Mktp US*9QR22' })),
    )
  })

  it('strips digits and punctuation', () => {
    expect(merchantKey(at({ payee: 'SQ *BLUE BOTTLE 0042' }))).toBe('BLUE BOTTLE')
  })

  it('drops tokens too short to identify anything', () => {
    // `SQ` and `US` carry no merchant identity.
    expect(merchantKey(at({ payee: 'AMZN Mktp US' }))).toBe('AMZN MKTP')
  })

  it('prefers the payee, which is the merchant at most institutions', () => {
    expect(merchantKey(at({ payee: 'Target', description: 'POS DEBIT 04/12 REF 99' }))).toBe(
      'TARGET',
    )
  })

  it('falls back to the description when there is no payee', () => {
    expect(merchantKey(at({ payee: null, description: 'WHOLE FOODS MARKET 123' }))).toBe(
      'WHOLE FOODS',
    )
  })

  it('reports nothing when there is no usable text', () => {
    expect(merchantKey(at({ payee: '', description: '' }))).toBeNull()
    expect(merchantKey(at({ payee: null, description: '04/12 99' }))).toBeNull()
  })

  it('ignores case', () => {
    expect(merchantKey(at({ payee: 'whole foods' }))).toBe(
      merchantKey(at({ payee: 'WHOLE FOODS' })),
    )
  })
})

describe('suggestRules', () => {
  it('groups a repeated merchant and counts it', () => {
    const suggestions = suggestRules([
      at({ payee: 'AMZN Mktp US*1', amountCents: -1000n }),
      at({ payee: 'AMZN Mktp US*2', amountCents: -2000n }),
    ])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.count).toBe(2)
    expect(suggestions[0]?.totalCents).toBe(-3000n)
  })

  /** One purchase is not a merchant, and a rule for it saves nobody anything. */
  it('ignores a merchant seen only once', () => {
    expect(suggestRules([at({ payee: 'ONE OFF SHOP' })])).toEqual([])
  })

  it('ignores transactions that already have a category', () => {
    const suggestions = suggestRules([
      at({ payee: 'AMZN Mktp US*1', categoryId: 'shopping' }),
      at({ payee: 'AMZN Mktp US*2', categoryId: 'shopping' }),
    ])
    expect(suggestions).toEqual([])
  })

  /**
   * The useful half: where the household already decided what this merchant is, the suggestion
   * carries their answer rather than a guess.
   */
  it('carries the category this household already used for the merchant', () => {
    const suggestions = suggestRules([
      at({ payee: 'AMZN Mktp US*0', categoryId: 'shopping' }),
      at({ payee: 'AMZN Mktp US*1' }),
      at({ payee: 'AMZN Mktp US*2' }),
    ])

    expect(suggestions[0]?.categoryId).toBe('shopping')
  })

  /** A coin flip presented as a suggestion is worse than no suggestion. */
  it('proposes no category when the household used two equally', () => {
    const suggestions = suggestRules([
      at({ payee: 'AMZN Mktp US*0', categoryId: 'shopping' }),
      at({ payee: 'AMZN Mktp US*9', categoryId: 'household' }),
      at({ payee: 'AMZN Mktp US*1' }),
      at({ payee: 'AMZN Mktp US*2' }),
    ])

    expect(suggestions[0]?.categoryId).toBeNull()
  })

  it('takes the commoner category when one clearly wins', () => {
    const suggestions = suggestRules([
      at({ payee: 'AMZN Mktp US*0', categoryId: 'shopping' }),
      at({ payee: 'AMZN Mktp US*8', categoryId: 'shopping' }),
      at({ payee: 'AMZN Mktp US*9', categoryId: 'household' }),
      at({ payee: 'AMZN Mktp US*1' }),
      at({ payee: 'AMZN Mktp US*2' }),
    ])

    expect(suggestions[0]?.categoryId).toBe('shopping')
  })

  /** Ordered by how much work each rule saves, not by how large the amounts are. */
  it('ranks by how many transactions a rule would catch', () => {
    const suggestions = suggestRules([
      at({ payee: 'BIG PURCHASE ONE', amountCents: -500_000n }),
      at({ payee: 'BIG PURCHASE TWO', amountCents: -500_000n }),
      at({ payee: 'COFFEE SHOP A', amountCents: -500n }),
      at({ payee: 'COFFEE SHOP B', amountCents: -500n }),
      at({ payee: 'COFFEE SHOP C', amountCents: -500n }),
    ])

    expect(suggestions[0]?.keyword).toBe('COFFEE SHOP')
    expect(suggestions[0]?.count).toBe(3)
  })

  it('keeps different merchants apart', () => {
    const suggestions = suggestRules([
      at({ payee: 'WHOLE FOODS 1' }),
      at({ payee: 'WHOLE FOODS 2' }),
      at({ payee: 'TRADER JOES 1' }),
      at({ payee: 'TRADER JOES 2' }),
    ])

    expect(suggestions.map((one) => one.keyword).sort()).toEqual(['TRADER JOES', 'WHOLE FOODS'])
  })

  it('has nothing to say about nothing', () => {
    expect(suggestRules([])).toEqual([])
  })
})
