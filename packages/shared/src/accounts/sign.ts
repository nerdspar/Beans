import type { AccountType } from './classification.js'
import { isLiability } from './classification.js'

/**
 * Sign sanity checks — defense 2 of 3 for the highest-risk code in the app.
 *
 * SimpleFIN institutions are inconsistent about whether a credit card balance arrives as a negative
 * number or as a positive magnitude of what is owed. Get it backwards and net worth is off by
 * **twice** the card balance, in a plausible-looking direction, with nothing raised anywhere. A
 * $3,000 card debt becomes a $3,000 asset: a $6,000 error that looks like a good month.
 *
 * The three defenses (ARCHITECTURE.md §3.3):
 *   1. Per-type normalization rules, in one module, recording which rule fired.
 *   2. These checks, which flag rather than silently accept.
 *   3. Connection-time confirmation, so a human sees the interpreted numbers before anything is
 *      committed.
 *
 * This module is pure: it takes an already-normalized amount and says whether the sign is
 * plausible for the account type. It never corrects anything — silently "fixing" a sign is how the
 * error becomes invisible.
 */

export type SignSeverity =
  /** Almost certainly a flipped sign. Blocks confirmation until a human looks. */
  | 'blocking'
  /** Possible but unusual. Surfaced, does not block. */
  | 'warning'

export type SignAnomaly = {
  severity: SignSeverity
  /** Written for a person deciding whether to accept the number, not for a log grep. */
  reason: string
}

/**
 * Checks whether a normalized balance has a plausible sign for its account type.
 *
 * Returns null when the sign is unremarkable.
 *
 * Amounts follow the storage convention: signed so they add directly to net worth, meaning
 * liabilities are negative (ARCHITECTURE.md §3.2).
 */
export function checkBalanceSign(type: AccountType, cents: bigint): SignAnomaly | null {
  if (cents === 0n) {
    // A zero balance is sign-neutral and extremely common — a paid-off card, a closed account, an
    // unfunded IRA. Flagging it would train the user to dismiss these.
    return null
  }

  if (isLiability(type)) {
    if (cents > 0n) {
      // A liability stored positive means it is *adding* to net worth. Nothing legitimate produces
      // that for a mortgage or loan.
      if (type === 'mortgage' || type === 'loan') {
        return {
          severity: 'blocking',
          reason:
            'This is recorded as money owed, but the balance is positive — which would add it to ' +
            'your net worth instead of subtracting it. That almost always means the sign is ' +
            'reversed.',
        }
      }

      return {
        severity: 'warning',
        reason:
          'This card has a positive balance, meaning the issuer owes you. That happens after a ' +
          'refund or an overpayment, but it is worth confirming the sign is right.',
      }
    }

    return null
  }

  if (cents < 0n) {
    if (type === 'investment') {
      return {
        severity: 'blocking',
        reason:
          'An investment account with a negative value is not something we can interpret. The ' +
          'sign is most likely reversed.',
      }
    }

    // Overdrafts and negative manual entries are legitimate, so this informs rather than blocks.
    return {
      severity: 'warning',
      reason:
        'This account has a negative balance. That is normal for an overdraft — worth a look.',
    }
  }

  return null
}

/**
 * Checks a whole set of discovered accounts, for the connection confirmation screen.
 *
 * Anomalies sort to the top there, blocking ones first, so the numbers most likely to be wrong are
 * the ones a human reads first.
 */
export function checkBalanceSigns<T extends { type: AccountType; balance: bigint }>(
  accounts: readonly T[],
): Array<{ account: T; anomaly: SignAnomaly }> {
  const flagged: Array<{ account: T; anomaly: SignAnomaly }> = []

  for (const account of accounts) {
    const anomaly = checkBalanceSign(account.type, account.balance)
    if (anomaly !== null) {
      flagged.push({ account, anomaly })
    }
  }

  return flagged.sort((a, b) => severityRank(a.anomaly.severity) - severityRank(b.anomaly.severity))
}

function severityRank(severity: SignSeverity): number {
  return severity === 'blocking' ? 0 : 1
}

/** True when any anomaly must be resolved before the connection can be committed. */
export function hasBlockingAnomaly(flagged: ReadonlyArray<{ anomaly: SignAnomaly }>): boolean {
  return flagged.some((entry) => entry.anomaly.severity === 'blocking')
}
