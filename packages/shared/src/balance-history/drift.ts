import { compareDates, type IsoDate } from './dates.js'

/**
 * Whether an account's transactions actually explain its balance.
 *
 * **This is the check the app thought it already had.** `checkReconstruction` compares the last
 * point of a derived series to the balance it was derived *from*, which is an invariant of the
 * algorithm rather than a fact about the data — it can only fail if reconstruction is buggy, and it
 * cannot see the failure it was written for.
 *
 * The failure is an institution reporting its balance and its transactions in opposite sign
 * conventions. Nothing errors. The chart is smooth and plausible and steadily wrong, and net worth
 * is off by an amount that grows.
 *
 * Catching it needs **two independent observations**, which is the thing reconstruction cannot
 * provide and every sync does: each one writes what the institution said the balance was on a given
 * day. Between two of those readings, the transactions either account for the change or they do
 * not:
 *
 *     drift = (observed later − observed earlier) − sum(transactions between)
 *
 * With signs agreeing, that is zero. With transactions inverted it is exactly **twice** the net
 * movement over the period, in the same direction as the movement — which is a signature rather
 * than a smell, and is why `likelyInverted` can say so specifically instead of shrugging at a
 * number being large.
 *
 * ---
 *
 * **Not wired to anything yet, and here is the blocker.** Cash, credit, loan and mortgage accounts
 * are rebuilt by backward reconstruction, which writes an entirely `derived` series — the balance
 * the provider reported on a given day is used as the anchor and then thrown away. Nothing in the
 * API writes an `observed` snapshot for them at all; the only such insert anywhere is the zero
 * after a closed account's closing date.
 *
 * So the independent readings this needs do not exist for precisely the accounts it is for. Making
 * it work means retaining each sync's reported balance as an `observed` snapshot and stopping
 * reconstruction from overwriting it — a change to how history is stored and drawn rather than a
 * wiring job, which is why this is finished and idle instead of half-connected.
 */

export type BalanceObservation = {
  date: IsoDate
  /** What the institution said, not what Beans derived. */
  balanceCents: bigint
}

export type DriftTransaction = {
  date: IsoDate
  amountCents: bigint
}

export type DriftInterval = {
  from: IsoDate
  to: IsoDate
  /** What the balance actually did between the two readings. */
  observedChangeCents: bigint
  /** What the transactions say it should have done. */
  explainedCents: bigint
  /** The gap. Zero when the two agree. */
  driftCents: bigint
}

export type DriftAnalysis = {
  intervals: DriftInterval[]
  /**
   * Drift in the same direction across enough consecutive intervals to stop being coincidence.
   *
   * One interval means nothing: a provider can miss a transaction, a pending row can settle at a
   * different amount, an institution's clock can disagree about a date. Those are as likely to go
   * one way as the other. A sign convention error is not — it drifts the same way every period,
   * forever.
   */
  sustained: boolean
  /** Total unexplained movement across the sustained run, for saying how much is at stake. */
  cumulativeDriftCents: bigint
  /**
   * The drift matches the specific signature of inverted transaction signs: twice the net movement,
   * same direction, interval after interval.
   *
   * Worth distinguishing because the remedy differs. Inverted signs are a setting; a provider
   * quietly not reporting some transactions is not something the reader can fix, and telling them
   * to flip a switch would make it worse.
   */
  likelyInverted: boolean
}

export type DriftOptions = {
  /**
   * Below this, an interval is treated as agreeing.
   *
   * A dollar. Rounding, a fee posted a day late, a currency conversion settling — none of these is
   * the failure being looked for, and a check that fires on them is one nobody reads.
   */
  toleranceCents?: bigint
  /** How many consecutive same-direction intervals before it is worth saying anything. */
  runLength?: number
}

const DEFAULT_TOLERANCE = 1_00n
const DEFAULT_RUN_LENGTH = 3

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

export function analyseDrift(
  observations: readonly BalanceObservation[],
  transactions: readonly DriftTransaction[],
  options: DriftOptions = {},
): DriftAnalysis {
  const tolerance = options.toleranceCents ?? DEFAULT_TOLERANCE
  const runLength = options.runLength ?? DEFAULT_RUN_LENGTH

  const ordered = [...observations].sort((left, right) => compareDates(left.date, right.date))

  const intervals: DriftInterval[] = []

  for (let index = 1; index < ordered.length; index += 1) {
    const earlier = ordered[index - 1]
    const later = ordered[index]
    if (earlier === undefined || later === undefined) continue

    /*
     * Strictly after the earlier reading, up to and including the later one.
     *
     * A transaction dated the same day as the earlier reading is already inside that balance —
     * counting it again would manufacture drift on an account that agrees perfectly, which is the
     * same off-by-one that makes backward reconstruction exclude transactions dated on its anchor.
     */
    const explained = transactions
      .filter(
        (transaction) =>
          compareDates(transaction.date, earlier.date) > 0 &&
          compareDates(transaction.date, later.date) <= 0,
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0n)

    const observedChange = later.balanceCents - earlier.balanceCents

    intervals.push({
      from: earlier.date,
      to: later.date,
      observedChangeCents: observedChange,
      explainedCents: explained,
      driftCents: observedChange - explained,
    })
  }

  /*
   * The longest run of consecutive intervals drifting the same way by more than the tolerance.
   *
   * Consecutive matters. Three drifting periods scattered across a year with agreeing ones between
   * them is a provider having occasional bad days; three in a row is a systematic disagreement.
   */
  let bestRun: DriftInterval[] = []
  let current: DriftInterval[] = []

  for (const interval of intervals) {
    const material = abs(interval.driftCents) > tolerance
    const sameDirection =
      current.length === 0 ||
      (current[0]!.driftCents > 0n) === (interval.driftCents > 0n)

    if (material && sameDirection) {
      current.push(interval)
    } else {
      current = material ? [interval] : []
    }

    if (current.length > bestRun.length) bestRun = [...current]
  }

  const sustained = bestRun.length >= runLength

  /*
   * Inverted signs produce drift of exactly twice the net movement. Allowed a quarter either side,
   * because a single missed transaction inside an otherwise inverted period shifts the ratio
   * without changing what is wrong — and because insisting on exactness would turn a diagnosis into
   * a coin flip.
   *
   * Intervals whose net movement is trivial are skipped rather than failed: inverted or not, twice
   * nothing is nothing, and they carry no evidence either way.
   */
  const informative = bestRun.filter((interval) => abs(interval.explainedCents) > tolerance)

  const likelyInverted =
    sustained &&
    informative.length > 0 &&
    informative.every((interval) => {
      const expected = -2n * interval.explainedCents
      const slack = abs(expected) / 4n
      return abs(interval.driftCents - expected) <= slack
    })

  return {
    intervals,
    sustained,
    cumulativeDriftCents: bestRun.reduce((sum, interval) => sum + interval.driftCents, 0n),
    likelyInverted,
  }
}
