/**
 * Turning a pile of uncategorized transactions into a short list of rules worth writing.
 *
 * ## Why this rather than a bundled merchant list
 *
 * A table of `STARBUCKS → Coffee` shipped with the app would categorize some things immediately and
 * would also be somebody else's guess about a household's own spending, permanently partial, and
 * stale the moment a merchant renames itself. This works from **the household's own transactions**,
 * which means it needs no external data, leaks nothing, and is right about the merchants that
 * actually appear rather than the ones a list author thought of.
 *
 * The leverage is the point: four hundred uncategorized transactions are usually twenty merchants.
 * Categorizing them one at a time is what nobody does; writing twenty rules is an afternoon that
 * ends.
 *
 * ## What it will not do
 *
 * It does not assign a category on its own. It proposes a keyword and, where the household has
 * already categorized the same merchant, the category they chose — and stops there. Guessing a
 * category from a merchant name is exactly the kind of confident-and-wrong that makes people stop
 * trusting automatic categorization, and undoing it across a year of history is worse than never
 * having had it.
 */

export type SuggestableTransaction = {
  payee: string | null
  description: string | null
  amountCents: bigint
  categoryId: string | null
}

export type RuleSuggestion = {
  /** The term a rule would match on, taken verbatim from the transactions rather than invented. */
  keyword: string
  /** How many uncategorized transactions it would catch. */
  count: number
  /** Their total, signed as stored — so spending is negative, like everywhere else. */
  totalCents: bigint
  /**
   * What this household already called this merchant, when they have.
   *
   * Null when they have not, in which case the suggestion is "here is a merchant worth a rule"
   * rather than "here is the category". Nothing here invents one.
   */
  categoryId: string | null
}

/** Below this a "merchant" is one purchase, and a rule for it saves nobody anything. */
const MIN_OCCURRENCES = 2

/** Tokens shorter than this carry no merchant identity — `US`, `SQ`, `TO`. */
const MIN_TOKEN_LENGTH = 3

/** More than this and the key stops being a merchant and starts being one transaction. */
const KEY_TOKENS = 2

/**
 * A merchant key from a transaction's text.
 *
 * Statement text is a merchant plus noise: `AMZN Mktp US*2K4LM`, `SQ *BLUE BOTTLE 0042`,
 * `POS DEBIT 04/12 TARGET T-1234`. The noise is what makes two visits to the same shop look like
 * two different merchants, so digits, punctuation and short tokens go, and the first couple of
 * surviving words are kept.
 *
 * Payee first: at most institutions it is the merchant, while the description carries a reference
 * number that will never repeat.
 *
 * Deliberately crude. It groups things a person then confirms, and over-splitting merely produces a
 * suggestion nobody accepts — where over-merging would propose a rule that miscategorizes.
 */
export function merchantKey(transaction: SuggestableTransaction): string | null {
  const source = (transaction.payee ?? transaction.description ?? '').trim()
  if (source === '') return null

  const tokens = source
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)

  if (tokens.length === 0) return null

  return tokens.slice(0, KEY_TOKENS).join(' ')
}

/**
 * Merchants worth a rule, commonest first.
 *
 * Ordered by how many transactions a rule would catch rather than by amount: the job is getting a
 * long tail categorized, and one large purchase does not need automating.
 */
export function suggestRules(
  transactions: readonly SuggestableTransaction[],
): RuleSuggestion[] {
  /*
   * What the household already decided, per merchant.
   *
   * Built from *categorized* transactions so a suggestion can carry the category they picked last
   * time. Where two categories were used for one merchant the commoner wins, and where it is a tie
   * nothing is proposed — a coin flip presented as a suggestion is worse than no suggestion.
   */
  const decided = new Map<string, Map<string, number>>()

  for (const transaction of transactions) {
    if (transaction.categoryId === null) continue
    const key = merchantKey(transaction)
    if (key === null) continue

    const counts = decided.get(key) ?? new Map<string, number>()
    counts.set(transaction.categoryId, (counts.get(transaction.categoryId) ?? 0) + 1)
    decided.set(key, counts)
  }

  const pending = new Map<string, { keyword: string; count: number; totalCents: bigint }>()

  for (const transaction of transactions) {
    if (transaction.categoryId !== null) continue
    const key = merchantKey(transaction)
    if (key === null) continue

    const existing = pending.get(key)
    pending.set(key, {
      // The keyword is the key itself, so what the rule matches on is what the reader was shown.
      keyword: key,
      count: (existing?.count ?? 0) + 1,
      totalCents: (existing?.totalCents ?? 0n) + transaction.amountCents,
    })
  }

  return [...pending.entries()]
    .filter(([, group]) => group.count >= MIN_OCCURRENCES)
    .map(([key, group]) => ({
      keyword: group.keyword,
      count: group.count,
      totalCents: group.totalCents,
      categoryId: dominantCategory(decided.get(key)),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        Number(absolute(right.totalCents) - absolute(left.totalCents)) ||
        left.keyword.localeCompare(right.keyword),
    )
}

/** The clear winner, or null. A tie is not an answer. */
function dominantCategory(counts: Map<string, number> | undefined): string | null {
  if (counts === undefined || counts.size === 0) return null

  const ranked = [...counts.entries()].sort(([, left], [, right]) => right - left)
  const best = ranked[0]
  const runnerUp = ranked[1]

  if (best === undefined) return null
  if (runnerUp !== undefined && runnerUp[1] === best[1]) return null

  return best[0]
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}
