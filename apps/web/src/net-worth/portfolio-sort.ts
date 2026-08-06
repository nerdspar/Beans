/**
 * Ordering the portfolio's account list.
 *
 * Pure, and separated from the screen, because the interesting cases are all about *absence*: an
 * account that has never moved has no day change, one connected this morning has no percentage, and
 * a sort that scatters those through the middle of the list is worse than one that does not sort at
 * all. Where they land is a decision, so it is a decision with tests on it.
 */

export type PortfolioSort = 'balance' | 'change' | 'changePercent' | 'name'

export type SortableAccount = {
  name: string
  /** Latest value in cents. */
  valueCents: bigint
  /** The day's market move in cents, or null when the account has never moved. */
  changeCents: bigint | null
  /** The same move as a fraction, or null when there was nothing to measure it against. */
  changeFraction: number | null
}

/**
 * Sorts a copy, largest or best first.
 *
 * No ascending toggle: each key has one obviously interesting end, and the other end is the bottom
 * of a list already on screen. Accounts with nothing to compare sort last under every numeric key
 * — they are not the worst performers, they are absent from the question, and putting them at the
 * bottom says that without pretending they are zero.
 *
 * Ties break on name so the order is stable rather than incidental. Two accounts at exactly the
 * same balance is not a corner case; it is two accounts holding nothing.
 */
export function sortAccounts<T extends SortableAccount>(
  accounts: readonly T[],
  sort: PortfolioSort,
): T[] {
  const byName = (left: T, right: T): number => left.name.localeCompare(right.name)

  return [...accounts].sort((left, right) => {
    if (sort === 'name') return byName(left, right)

    if (sort === 'balance') {
      // Compared as bigints, never subtracted into a Number: a portfolio above 2^53 cents would
      // start returning nonsense comparisons, and the sort would silently be wrong rather than fail.
      if (left.valueCents !== right.valueCents) return left.valueCents > right.valueCents ? -1 : 1
      return byName(left, right)
    }

    const leftValue = sort === 'change' ? left.changeCents : left.changeFraction
    const rightValue = sort === 'change' ? right.changeCents : right.changeFraction

    // Absent sorts last under every numeric key, whichever side it is on.
    if (leftValue === null && rightValue === null) return byName(left, right)
    if (leftValue === null) return 1
    if (rightValue === null) return -1

    if (leftValue === rightValue) return byName(left, right)
    return leftValue > rightValue ? -1 : 1
  })
}
