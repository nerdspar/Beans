/**
 * Rules: categorizing transactions without doing it by hand.
 *
 * A household has hundreds of transactions and gains more every sync. Categorizing by hand once is
 * tedious; doing it again after every sync is not going to happen, so anything relying on categories
 * — cash flow breakdowns, budgets — depends on rules working.
 *
 * Pure, so the matching semantics are testable without a database. The order rules run in and what
 * happens when two match are decisions with consequences, not implementation detail.
 */

export type RuleMatchType = 'contains' | 'regex'

/**
 * How a rule's keywords combine.
 *
 * `any` is the default because it matches what somebody means by "these are the words for this
 * merchant" — an institution writes the same shop three ways and any of them should count. `all`
 * narrows: AMAZON *and* PRIME, when AMAZON alone catches too much.
 */
export type KeywordMode = 'any' | 'all'

export type CategoryRule = {
  id: string
  /** Lower runs first. Ties broken by creation order, applied by the caller's sort. */
  priority: number
  enabled: boolean
  /**
   * The terms this rule looks for. Empty means the rule states no text condition.
   *
   * A list rather than one string because the same merchant arrives spelled several ways, and
   * making somebody write `AMZN|AMAZON MKTPL` as a regex to express "either of these" is asking
   * them to learn a syntax to say something ordinary.
   */
  keywords: readonly string[]
  keywordMode: KeywordMode
  matchType: RuleMatchType
  /** Signed cents, matched against the transaction's own signed amount. */
  matchAmountMin: bigint | null
  matchAmountMax: bigint | null
  matchAccountId: string | null
  categoryId: string
}

export type MatchableTransaction = {
  accountId: string
  amountCents: bigint
  description: string | null
  payee: string | null
}

/**
 * Whether one rule matches one transaction.
 *
 * **Every condition a rule specifies must hold**, and conditions it leaves null are ignored. A rule
 * with no conditions at all matches nothing rather than everything — the empty rule is far more
 * likely to be a half-finished edit than a deliberate catch-all, and the catch-all interpretation
 * silently recategorizes the entire history.
 *
 * Text is matched against payee and description together, because institutions disagree about which
 * one carries the merchant name and a user should not have to know which.
 */
export function ruleMatches(rule: CategoryRule, transaction: MatchableTransaction): boolean {
  if (!rule.enabled) return false

  const hasCondition =
    rule.keywords.length > 0 ||
    rule.matchAmountMin !== null ||
    rule.matchAmountMax !== null ||
    rule.matchAccountId !== null

  if (!hasCondition) return false

  if (rule.matchAccountId !== null && rule.matchAccountId !== transaction.accountId) {
    return false
  }

  if (rule.matchAmountMin !== null && transaction.amountCents < rule.matchAmountMin) return false
  if (rule.matchAmountMax !== null && transaction.amountCents > rule.matchAmountMax) return false

  if (rule.keywords.length > 0) {
    const haystack = `${transaction.payee ?? ''} ${transaction.description ?? ''}`

    /*
     * `any` is an OR across the terms, `all` an AND. Blank terms are ignored rather than treated as
     * matching everything — a trailing empty chip from a half-finished edit would otherwise turn an
     * `any` rule into a catch-all and recategorize the entire history.
     */
    const terms = rule.keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword !== '')
    if (terms.length === 0) return false

    const hit = (term: string): boolean => matchesTerm(term, haystack, rule.matchType)

    return rule.keywordMode === 'all' ? terms.every(hit) : terms.some(hit)
  }

  return true
}

function matchesTerm(term: string, haystack: string, matchType: RuleMatchType): boolean {
  if (matchType === 'regex') {
    /*
     * A malformed pattern must not take the whole categorization run down with it. One bad rule
     * saved months ago should not stop today's sync from categorizing anything at all, so it
     * simply fails to match and the others carry on.
     */
    try {
      return new RegExp(term, 'i').test(haystack)
    } catch {
      return false
    }
  }

  return haystack.toLowerCase().includes(term.toLowerCase())
}

/**
 * The category a set of rules assigns, or null.
 *
 * **First match wins**, by priority then creation order. Not last, and not "most specific" — a
 * specificity heuristic sounds better until two rules disagree and the user cannot tell which one
 * won or why. An explicit order they control is predictable, and reordering is a thing they can do.
 */
export function categoryForTransaction(
  rules: readonly CategoryRule[],
  transaction: MatchableTransaction,
): string | null {
  for (const rule of rules) {
    if (ruleMatches(rule, transaction)) return rule.categoryId
  }
  return null
}

/** Sorts rules into the order they are applied in. Callers should sort once, not per transaction. */
export function inRuleOrder<T extends { priority: number; createdAt?: string | undefined }>(
  rules: readonly T[],
): T[] {
  return [...rules].sort(
    (left, right) =>
      left.priority - right.priority || (left.createdAt ?? '').localeCompare(right.createdAt ?? ''),
  )
}
