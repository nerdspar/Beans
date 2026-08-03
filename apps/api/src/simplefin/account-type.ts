import type { AccountType } from '@beans/shared'

/**
 * Guessing an account type from its name.
 *
 * **SimpleFIN sends no account type field.** No `type`, no `subtype` — nothing. Yet type decides
 * whether a balance is an asset or a liability, which net worth section it appears in, and which
 * balance-history method applies to it. It is not optional information.
 *
 * So it has to come from the user. This module exists only to **pre-fill** the confirmation screen
 * so the common cases need no thought, not to decide anything. Every guess carries a confidence,
 * and a low-confidence guess is presented as an unanswered question rather than a default to skim
 * past — "Adv Relationship Banking" defeats any heuristic, and quietly guessing `depository` for it
 * would be worse than admitting we do not know.
 *
 * Never let a guess from here overwrite a user's choice: that is what `accounts.type_is_user_set`
 * is for.
 */

export type TypeGuess = {
  type: AccountType
  /**
   * `high` pre-fills and reads as an answer. `low` pre-fills but is presented as needing
   * confirmation, because getting it wrong flips a balance between the asset and liability columns.
   */
  confidence: 'high' | 'low'
  /** Shown beside the guess so the user can see why, rather than trusting a black box. */
  basis: string
}

type Rule = {
  pattern: RegExp
  type: AccountType
  confidence: 'high' | 'low'
  basis: string
}

/**
 * Ordered — the first match wins, so the most specific patterns come first.
 *
 * "Home Equity Line of Credit" must reach the loan rule before the word "credit" pulls it into
 * credit card, and "Mortgage" must beat "loan". Reordering this list changes behavior.
 */
const RULES: readonly Rule[] = [
  {
    pattern: /\bmortgage\b/i,
    type: 'mortgage',
    confidence: 'high',
    basis: 'name mentions a mortgage',
  },
  {
    pattern: /\bheloc\b|home equity/i,
    type: 'loan',
    confidence: 'high',
    basis: 'name mentions home equity',
  },
  {
    pattern: /\b(auto|car|student|personal)\s+loan\b|\bloan\b/i,
    type: 'loan',
    confidence: 'high',
    basis: 'name mentions a loan',
  },
  {
    pattern: /\b(credit\s*card|visa|mastercard|amex|american express|discover)\b/i,
    type: 'credit',
    confidence: 'high',
    basis: 'name mentions a credit card',
  },
  /**
   * Debit has to be checked before the bare `card` rule below, or every debit card would be
   * classified as a credit account — flipping a cash asset into a liability.
   */
  {
    pattern: /\bdebit\b/i,
    type: 'depository',
    confidence: 'high',
    basis: 'name mentions a debit card',
  },
  {
    pattern: /\bcard\b/i,
    type: 'credit',
    confidence: 'high',
    basis: 'name mentions a card, and debit was ruled out',
  },
  {
    pattern: /\b(401\s*\(?k\)?|403\s*\(?b\)?|457|ira|roth|rollover|pension|profit sharing)\b/i,
    type: 'investment',
    confidence: 'high',
    basis: 'name mentions a retirement account',
  },
  {
    pattern: /\b(brokerage|investment|securities|portfolio|utma|ugma|529|hsa)\b/i,
    type: 'investment',
    confidence: 'high',
    basis: 'name mentions an investment account',
  },
  {
    pattern: /\b(checking|chequing|current account)\b/i,
    type: 'depository',
    confidence: 'high',
    basis: 'name mentions checking',
  },
  {
    pattern: /\b(savings|saver|money market|\bcd\b|certificate of deposit)\b/i,
    type: 'depository',
    confidence: 'high',
    basis: 'name mentions savings',
  },
]

/**
 * Guesses an account type from the provider's name and institution.
 *
 * Falls back to `depository` at **low** confidence — the most common account kind, but explicitly
 * marked as a guess so the UI asks rather than assumes.
 */
export function guessAccountType(accountName: string, orgName?: string | null): TypeGuess {
  const haystack = `${accountName} ${orgName ?? ''}`

  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) {
      return { type: rule.type, confidence: rule.confidence, basis: rule.basis }
    }
  }

  return {
    type: 'depository',
    confidence: 'low',
    basis: 'no recognizable keyword in the name',
  }
}

/**
 * Whether the provider's sign for this balance disagrees with our convention, given the type.
 *
 * Used only to **pre-fill** the sign toggle on the confirmation screen, and only when the type
 * guess is high confidence — pre-filling a sign flip off a shaky type guess would compound two
 * uncertainties into a number that looks authoritative.
 *
 * Returns null when there is nothing to suggest, including for a zero balance, where the sign
 * carries no information at all.
 */
export function suggestSignInversion(
  guess: TypeGuess,
  providerBalanceCents: bigint,
): boolean | null {
  if (providerBalanceCents === 0n || guess.confidence === 'low') {
    return null
  }

  const isLiabilityType =
    guess.type === 'credit' || guess.type === 'loan' || guess.type === 'mortgage'

  // Our convention: liabilities negative, assets positive (ARCHITECTURE.md §3.2).
  if (isLiabilityType) {
    return providerBalanceCents > 0n
  }

  // Assets reported negative are far more likely an overdraft than an inverted sign, so nothing is
  // suggested here. The sign check will still warn, and a human decides.
  return null
}

/*
 * `applySignConvention` now lives in `@beans/shared`, re-exported here so existing imports keep
 * working. It moved because the confirmation screen has to apply the identical rule to show what
 * will be recorded, and a second copy in the client got it wrong.
 */
export { applySignConvention } from '@beans/shared'
