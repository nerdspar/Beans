import type { IsoDate } from '../balance-history/dates.js'
import { compareDates } from '../balance-history/dates.js'
import type { TaxTreatment } from '../accounts/classification.js'

/**
 * Splitting one account across tax treatments, and carrying that split forward.
 *
 * A single 401(k) commonly holds pre-tax, Roth and after-tax money at once. SimpleFIN reports one
 * balance for the account and will never break it out, so the split is a user-maintained overlay:
 * they enter what their provider showed them on a date, and that row is an **anchor**.
 *
 * **A fixed percentage is wrong and will drift**, which is the whole reason this file exists. A
 * frozen traditional balance beside an actively contributed Roth balance changes ratio every year
 * on its own — growth alone preserves the ratio, contributions do not. Modelling the split as a
 * constant would be quietly wrong in a way that compounds.
 *
 * **This is a modelling overlay only.** Net worth, the account list and every phase 1 view continue
 * to read the account balance and are unaffected (spec, and §4.1: `current_balance` is the input).
 * Only the projection and the after-tax equivalent read buckets.
 *
 * ---
 *
 * One deliberate departure from the spec, because Beans has data the spec assumed it would model:
 * the carry-forward computes **proportions**, which are then applied to the account's *actual*
 * balance. The spec describes carrying balances forward directly, which would let the modelled
 * total drift away from what the institution actually reports — and the entire value of Beans is
 * that it knows the real number. Growth and contribution assumptions decide how the pie is sliced;
 * the provider decides how big the pie is.
 */

export type BucketBalance = {
  treatment: TaxTreatment
  balanceCents: bigint
}

/** What the provider showed the user, on the day they read it. */
export type BucketAnchor = {
  asOfDate: IsoDate
  buckets: readonly BucketBalance[]
}

/** Where new money lands. Absent treatments simply receive nothing. */
export type ContributionRouting = {
  treatment: TaxTreatment
  /** Per year, in cents. The projection works in annual steps. */
  annualCents: bigint
}

export type CarryForwardOptions = {
  anchors: readonly BucketAnchor[]
  routing: readonly ContributionRouting[]
  /** Assumed real return, in basis points a year. 600 is 6%. Matches the personal index. */
  annualReturnBasisPoints: bigint
  /** The date to carry to. Anchors after it are ignored — a plan is not a time machine. */
  asOf: IsoDate
  /**
   * The account's real balance on `asOf`.
   *
   * The proportions are modelled; the total is observed. Passing this is what keeps a ten-year-old
   * anchor from quietly disagreeing with the number on the account screen.
   */
  actualBalanceCents: bigint
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

/**
 * The split at `asOf`, as absolute cents summing exactly to the account's real balance.
 *
 * Returns an empty array when there is no anchor to work from. An account nobody has broken out has
 * no known split, and inventing one — "probably all pre-tax" — is the kind of quiet guess that
 * produces a confident, wrong after-tax figure.
 */
export function carryBucketsForward(options: CarryForwardOptions): BucketBalance[] {
  const { anchors, routing, annualReturnBasisPoints, asOf, actualBalanceCents } = options

  /*
   * The most recent anchor at or before the date. Later anchors are the user telling us the model
   * was wrong; earlier ones are superseded. Re-basing from the newest available reading is the
   * whole point of letting them enter a fresh breakdown.
   */
  const usable = anchors
    .filter((anchor) => compareDates(anchor.asOfDate, asOf) <= 0)
    .sort((left, right) => compareDates(left.asOfDate, right.asOfDate))

  const anchor = usable.at(-1)
  if (anchor === undefined || anchor.buckets.length === 0) return []

  // Modelled forward from the anchor. Absolute values here are provisional — only their ratio is
  // used — but modelling them as amounts is what makes contributions and growth interact correctly.
  const modelled = new Map<TaxTreatment, bigint>()
  for (const bucket of anchor.buckets) {
    modelled.set(bucket.treatment, (modelled.get(bucket.treatment) ?? 0n) + bucket.balanceCents)
  }

  const years = wholeYearsBetween(anchor.asOfDate, asOf)

  /*
   * Weights are carried **unrounded**, which is why there is no division in this loop.
   *
   * Rounding each bucket every year drifts: with no contributions at all, ten rounded growth steps
   * left a 60/40 split off by a cent, so growth appeared to move a ratio it cannot move. Growth is
   * proportional by definition and must be exactly so.
   *
   * Instead the divisor is deferred. Each step multiplies by `10_000 + rate` and tracks the matching
   * power of 10,000 in `scale`; contributions enter at whatever scale is current. Only ratios are
   * ever read from these, and the common factor cancels — so the numbers get large and stay exact,
   * which is the correct trade for money.
   */
  let scale = 1n

  for (let year = 0; year < years; year += 1) {
    for (const [treatment, weight] of modelled) {
      modelled.set(treatment, weight * (10_000n + annualReturnBasisPoints))
    }
    scale *= 10_000n

    /*
     * Contributions land after that year's growth. A year's contributions arrive across the year
     * rather than at its start, so growing them for the full year would overstate — and overstating
     * the contributed bucket is exactly the direction that flatters a Roth balance.
     */
    for (const route of routing) {
      if (route.annualCents === 0n) continue
      modelled.set(route.treatment, (modelled.get(route.treatment) ?? 0n) + route.annualCents * scale)
    }
  }

  return distribute(actualBalanceCents, modelled)
}

/**
 * Splits a real total across modelled weights, with the parts summing exactly to the whole.
 *
 * The remainder goes to the largest bucket rather than being dropped. Cents that vanish in a split
 * are how a balance sheet stops balancing, and the largest bucket is where a single cent is least
 * visible — which is the right place for an artefact of rounding to land.
 */
function distribute(totalCents: bigint, weights: ReadonlyMap<TaxTreatment, bigint>): BucketBalance[] {
  /*
   * Zero-weight buckets are kept, not filtered out. An anchor naming a bucket with nothing in it is
   * the user saying that bucket exists and is empty, which is a different statement from not
   * mentioning it — and dropping it would make a freshly opened account report no split at all.
   */
  const entries = [...weights.entries()]
  if (entries.length === 0) return []

  const weightSum = entries.reduce((sum, [, weight]) => sum + weight, 0n)

  /*
   * A modelled total of zero cannot be divided by. It happens when an anchor records every bucket
   * at zero — a brand new account, entered before the first contribution landed — and the honest
   * answer is an even split rather than a division error or a silent empty result.
   */
  if (weightSum === 0n) {
    return entries.map(([treatment]) => ({ treatment, balanceCents: 0n }))
  }

  const parts = entries.map(([treatment, weight]) => ({
    treatment,
    balanceCents: (totalCents * weight) / weightSum,
    weight,
  }))

  const distributed = parts.reduce((sum, part) => sum + part.balanceCents, 0n)
  const remainder = totalCents - distributed

  if (remainder !== 0n) {
    let largest = 0
    for (let index = 1; index < parts.length; index += 1) {
      if (abs(parts[index]!.weight) > abs(parts[largest]!.weight)) largest = index
    }
    parts[largest]!.balanceCents += remainder
  }

  return parts.map(({ treatment, balanceCents }) => ({ treatment, balanceCents }))
}

/**
 * Whole years between two dates, which is the projection's timestep.
 *
 * Whole rather than fractional because contributions are annual figures: crediting eleven months of
 * a year's contribution implies a monthly cadence the user never stated. A partial year carries
 * nothing, which understates slightly and is the safer direction for a retirement number.
 */
function wholeYearsBetween(from: IsoDate, to: IsoDate): number {
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)

  let years = end.getUTCFullYear() - start.getUTCFullYear()
  const anniversary = new Date(start)
  anniversary.setUTCFullYear(start.getUTCFullYear() + years)
  if (anniversary.getTime() > end.getTime()) years -= 1

  return Math.max(0, years)
}
