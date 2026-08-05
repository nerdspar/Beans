import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES, TRANSFER_CATEGORY_SLUG } from './defaults.js'
import { categoryForTransaction, inRuleOrder, ruleMatches, type CategoryRule } from './rules.js'

function rule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  return {
    id: 'r1',
    priority: 0,
    enabled: true,
    keywords: [],
    keywordMode: 'any',
    matchType: 'contains',
    matchAmountMin: null,
    matchAmountMax: null,
    matchAccountId: null,
    categoryId: 'groceries',
    ...overrides,
  }
}

const purchase = {
  accountId: 'card',
  amountCents: -4_523n,
  description: 'PURCHASE AUTHORIZED',
  payee: 'WHOLE FOODS MARKET',
}

describe('ruleMatches', () => {
  it('matches payee or description, without the user knowing which carries the name', () => {
    expect(ruleMatches(rule({ keywords: ['whole foods'] }), purchase)).toBe(true)
    expect(ruleMatches(rule({ keywords: ['authorized'] }), purchase)).toBe(true)
  })

  it('is case insensitive', () => {
    expect(ruleMatches(rule({ keywords: ['WhOlE fOoDs'] }), purchase)).toBe(true)
  })

  it('requires every condition a rule specifies', () => {
    // Right merchant, wrong account.
    expect(
      ruleMatches(rule({ keywords: ['whole foods'], matchAccountId: 'checking' }), purchase),
    ).toBe(false)
  })

  it('matches signed amounts, so a range means what it says', () => {
    // Spending is negative: "between -$50 and -$40" is a band of ordinary purchases.
    expect(
      ruleMatches(rule({ matchAmountMin: -5_000n, matchAmountMax: -4_000n }), purchase),
    ).toBe(true)
    expect(ruleMatches(rule({ matchAmountMin: 4_000n, matchAmountMax: 5_000n }), purchase)).toBe(
      false,
    )
  })

  it('ignores a disabled rule', () => {
    expect(ruleMatches(rule({ keywords: ['whole foods'], enabled: false }), purchase)).toBe(
      false,
    )
  })

  /**
   * The dangerous default. An empty rule is far more likely to be a half-finished edit than a
   * deliberate catch-all, and treating it as one would recategorize the entire history in a click.
   */
  it('matches nothing when a rule specifies no conditions', () => {
    expect(ruleMatches(rule(), purchase)).toBe(false)
  })

  describe('regex', () => {
    it('matches a pattern', () => {
      expect(
        ruleMatches(rule({ matchType: 'regex', keywords: ['^WHOLE\\s+FOODS'] }), purchase),
      ).toBe(true)
    })

    /** One bad pattern saved months ago must not stop today's sync categorizing anything at all. */
    it('fails to match rather than throwing on a malformed pattern', () => {
      expect(() =>
        ruleMatches(rule({ matchType: 'regex', keywords: ['([unclosed'] }), purchase),
      ).not.toThrow()

      expect(ruleMatches(rule({ matchType: 'regex', keywords: ['([unclosed'] }), purchase)).toBe(
        false,
      )
    })
  })
})

describe('categoryForTransaction', () => {
  it('takes the first match in order, not the most specific', () => {
    const rules = inRuleOrder([
      rule({ id: 'general', priority: 1, keywords: ['whole foods'], categoryId: 'food' }),
      rule({ id: 'specific', priority: 2, keywords: ['whole foods market'], categoryId: 'groceries' }),
    ])

    // A specificity heuristic would pick 'groceries'; predictable order picks the first.
    expect(categoryForTransaction(rules, purchase)).toBe('food')
  })

  it('returns null when nothing matches, rather than guessing', () => {
    expect(categoryForTransaction([rule({ keywords: ['shell'] })], purchase)).toBeNull()
  })

  it('breaks priority ties by creation order', () => {
    const rules = inRuleOrder([
      { ...rule({ id: 'second', keywords: ['whole'], categoryId: 'b' }), createdAt: '2026-02' },
      { ...rule({ id: 'first', keywords: ['whole'], categoryId: 'a' }), createdAt: '2026-01' },
    ])

    expect(categoryForTransaction(rules, purchase)).toBe('a')
  })
})

describe('the default set', () => {
  it('has unique slugs', () => {
    const slugs = DEFAULT_CATEGORIES.map((category) => category.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('nests no deeper than two levels', () => {
    // A category with a parent may not itself be a parent (ARCHITECTURE.md §8).
    const parents = new Set(DEFAULT_CATEGORIES.map((c) => c.parent).filter(Boolean))
    for (const slug of parents) {
      const parent = DEFAULT_CATEGORIES.find((c) => c.slug === slug)
      expect(parent, `${String(slug)} is referenced as a parent`).toBeDefined()
      expect(parent?.parent, `${String(slug)} is itself nested`).toBeUndefined()
    }
  })

  it('gives every child the same kind as its parent', () => {
    for (const category of DEFAULT_CATEGORIES) {
      if (category.parent === undefined) continue
      const parent = DEFAULT_CATEGORIES.find((c) => c.slug === category.parent)
      expect(category.kind, `${category.slug} vs its parent`).toBe(parent?.kind)
    }
  })

  /** Cash flow excludes anything whose category kind is transfer. Removing this breaks that path. */
  it('includes exactly one transfer category, at the slug cash flow relies on', () => {
    const transfers = DEFAULT_CATEGORIES.filter((c) => c.kind === 'transfer')
    expect(transfers).toHaveLength(1)
    expect(transfers[0]?.slug).toBe(TRANSFER_CATEGORY_SLUG)
  })
})

/**
 * Several terms for one merchant, combined.
 *
 * An institution writes the same shop three ways — `AMZN Mktp`, `AMAZON.COM`, `Amazon Prime` — and
 * expressing "any of these" should not require learning regex alternation.
 */
describe('keywords', () => {
  const amazon = {
    accountId: 'checking',
    amountCents: -4299n,
    description: 'AMZN Mktp US*2K4LM',
    payee: 'Amazon',
  }

  it('matches when any keyword hits, by default', () => {
    expect(ruleMatches(rule({ keywords: ['walmart', 'amzn'] }), amazon)).toBe(true)
  })

  it('does not match when no keyword hits', () => {
    expect(ruleMatches(rule({ keywords: ['walmart', 'target'] }), amazon)).toBe(false)
  })

  it('requires every keyword under all', () => {
    expect(ruleMatches(rule({ keywords: ['amzn', 'mktp'], keywordMode: 'all' }), amazon)).toBe(true)
    expect(ruleMatches(rule({ keywords: ['amzn', 'prime'], keywordMode: 'all' }), amazon)).toBe(
      false,
    )
  })

  it('searches payee and description together, so either can carry the merchant', () => {
    expect(ruleMatches(rule({ keywords: ['amazon'] }), amazon)).toBe(true)
    expect(ruleMatches(rule({ keywords: ['2k4lm'] }), amazon)).toBe(true)
  })

  it('ignores case in every term', () => {
    expect(ruleMatches(rule({ keywords: ['AmZn', 'MKTP'], keywordMode: 'all' }), amazon)).toBe(true)
  })

  /**
   * The dangerous one. A trailing blank chip from a half-finished edit must not turn an `any` rule
   * into a catch-all — that silently recategorizes the whole history.
   */
  it('ignores blank terms rather than treating them as matching everything', () => {
    expect(ruleMatches(rule({ keywords: ['walmart', '  '] }), amazon)).toBe(false)
    expect(ruleMatches(rule({ keywords: ['', '   '] }), amazon)).toBe(false)
  })

  it('still matches on the real terms beside a blank one', () => {
    expect(ruleMatches(rule({ keywords: ['amzn', ''] }), amazon)).toBe(true)
  })

  it('applies every keyword as a pattern under regex', () => {
    expect(
      ruleMatches(rule({ matchType: 'regex', keywords: ['AMZN\\s+Mktp', 'nothing'] }), amazon),
    ).toBe(true)
    expect(
      ruleMatches(
        rule({ matchType: 'regex', keywords: ['AMZN', '([unclosed'], keywordMode: 'all' }),
        amazon,
      ),
    ).toBe(false)
  })

  /**
   * Worth pinning down because it surprises people writing rules: the haystack is payee *and*
   * description joined, so `^` anchors to the start of the payee, not of the description.
   */
  it('anchors a regex to the payee and description combined', () => {
    expect(ruleMatches(rule({ matchType: 'regex', keywords: ['^Amazon'] }), amazon)).toBe(true)
    expect(ruleMatches(rule({ matchType: 'regex', keywords: ['^AMZN'] }), amazon)).toBe(false)
  })

  it('still requires the other conditions to hold', () => {
    expect(
      ruleMatches(rule({ keywords: ['amzn'], matchAccountId: 'savings' }), amazon),
    ).toBe(false)
    expect(
      ruleMatches(rule({ keywords: ['amzn'], matchAmountMin: 0n }), amazon),
    ).toBe(false)
  })
})
