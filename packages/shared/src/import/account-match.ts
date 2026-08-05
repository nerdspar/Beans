/**
 * Guessing which Beans account a name in a CSV refers to.
 *
 * A whole-portfolio export names its accounts the way the institution writes them — `Scott Checking
 * - Ending in 9224`, `Group Id:ab - Ending in 99ab` — and a household with forty accounts has forty
 * of these to match by hand, from a dropdown, one at a time. Most of them are decidable: the digits
 * on the end are the same last four the provider already reports as the account's mask.
 *
 * **A guess, never a decision.** Every match this makes is pre-selected in a control the user can
 * change, and the screen still refuses to proceed with nothing matched. Filing a year of
 * transactions against the wrong account is the exact failure the matching step exists to prevent,
 * so a wrong guess must cost a glance, not a silent misfiling.
 */

export type MatchableAccount = {
  id: string
  /** The last four the provider reports. Null when it reports none. */
  mask: string | null
  name: string
}

/**
 * The last four digits a name ends with, or null.
 *
 * Anchored to the **end** deliberately. A name like `Group Id:ab - Ending in 99ab` contains other
 * digits, and matching the first run found would pair accounts on a fragment of an identifier
 * rather than on the mask. Trailing non-digits are ignored so `9224)` and `9224.` still read.
 */
export function trailingDigits(value: string): string | null {
  const match = /(\d{4})\D*$/.exec(value.trim())
  return match?.[1] ?? null
}

/**
 * Names paired to accounts, where exactly one account claims those four digits.
 *
 * **Ambiguity is left unmatched rather than resolved.** Two accounts ending 1234 is precisely when a
 * guess is most likely wrong and least likely to be noticed — the name looks handled, so nobody
 * looks again. The same applies in reverse: two CSV names ending 1234 could be one account written
 * two ways or two accounts, and nothing here can tell which.
 *
 * Names already matched by the caller are left alone, so re-running never overwrites a human answer.
 */
export function matchAccountsByMask(
  names: readonly string[],
  accounts: readonly MatchableAccount[],
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const byMask = new Map<string, MatchableAccount[]>()

  for (const account of accounts) {
    const mask = account.mask === null ? null : trailingDigits(account.mask)
    if (mask === null) continue
    byMask.set(mask, [...(byMask.get(mask) ?? []), account])
  }

  const matched: Record<string, string> = {}

  /* How many names want each mask, so a mask two names claim is left to the human. */
  const wanted = new Map<string, number>()
  for (const name of names) {
    const digits = trailingDigits(name)
    if (digits !== null) wanted.set(digits, (wanted.get(digits) ?? 0) + 1)
  }

  for (const name of names) {
    if ((existing[name] ?? '') !== '') continue

    const digits = trailingDigits(name)
    if (digits === null) continue
    if ((wanted.get(digits) ?? 0) > 1) continue

    const candidates = byMask.get(digits)
    if (candidates === undefined || candidates.length !== 1) continue

    matched[name] = candidates[0]!.id
  }

  return matched
}
