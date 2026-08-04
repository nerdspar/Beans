import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES, TRANSFER_CATEGORY_SLUG } from './defaults.js'
import { categoryForTransaction, inRuleOrder, ruleMatches, type CategoryRule } from './rules.js'

function rule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  return {
    id: 'r1',
    priority: 0,
    enabled: true,
    matchDescription: null,
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
    expect(ruleMatches(rule({ matchDescription: 'whole foods' }), purchase)).toBe(true)
    expect(ruleMatches(rule({ matchDescription: 'authorized' }), purchase)).toBe(true)
  })

  it('is case insensitive', () => {
    expect(ruleMatches(rule({ matchDescription: 'WhOlE fOoDs' }), purchase)).toBe(true)
  })

  it('requires every condition a rule specifies', () => {
    // Right merchant, wrong account.
    expect(
      ruleMatches(rule({ matchDescription: 'whole foods', matchAccountId: 'checking' }), purchase),
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
    expect(ruleMatches(rule({ matchDescription: 'whole foods', enabled: false }), purchase)).toBe(
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
        ruleMatches(rule({ matchType: 'regex', matchDescription: '^WHOLE\\s+FOODS' }), purchase),
      ).toBe(true)
    })

    /** One bad pattern saved months ago must not stop today's sync categorizing anything at all. */
    it('fails to match rather than throwing on a malformed pattern', () => {
      expect(() =>
        ruleMatches(rule({ matchType: 'regex', matchDescription: '([unclosed' }), purchase),
      ).not.toThrow()

      expect(ruleMatches(rule({ matchType: 'regex', matchDescription: '([unclosed' }), purchase)).toBe(
        false,
      )
    })
  })
})

describe('categoryForTransaction', () => {
  it('takes the first match in order, not the most specific', () => {
    const rules = inRuleOrder([
      rule({ id: 'general', priority: 1, matchDescription: 'whole foods', categoryId: 'food' }),
      rule({ id: 'specific', priority: 2, matchDescription: 'whole foods market', categoryId: 'groceries' }),
    ])

    // A specificity heuristic would pick 'groceries'; predictable order picks the first.
    expect(categoryForTransaction(rules, purchase)).toBe('food')
  })

  it('returns null when nothing matches, rather than guessing', () => {
    expect(categoryForTransaction([rule({ matchDescription: 'shell' })], purchase)).toBeNull()
  })

  it('breaks priority ties by creation order', () => {
    const rules = inRuleOrder([
      { ...rule({ id: 'second', matchDescription: 'whole', categoryId: 'b' }), createdAt: '2026-02' },
      { ...rule({ id: 'first', matchDescription: 'whole', categoryId: 'a' }), createdAt: '2026-01' },
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
