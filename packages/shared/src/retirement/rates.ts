/**
 * Rates, applied to money, with one rounding rule.
 *
 * Every rate in the retirement engine is **basis points as an integer** — 600 is 6%. No floats
 * reach the money path: a `number` rate multiplied into a balance is how a projection ends up
 * disagreeing with itself in the third decimal place and then in the dollars.
 *
 * All of it rounds **half away from zero**, on the magnitude, with the sign reapplied. BigInt
 * division truncates toward zero, which on a negative amount rounds down in magnitude — and since
 * spending is negative throughout this feature (§3.2), plain truncation would shave a cent off
 * every cost, every year, always in the flattering direction. Bias in a retirement number is worse
 * than error.
 */

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

/** `amountCents * numerator / denominator`, rounded half away from zero. */
export function scaleSigned(amountCents: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('scaleSigned: denominator must not be zero')

  const magnitude = (abs(amountCents) * abs(numerator) + abs(denominator) / 2n) / abs(denominator)
  const negative = amountCents < 0n !== (numerator < 0n !== denominator < 0n)
  return negative ? -magnitude : magnitude
}

/**
 * One year of growth at a real rate. `grow(100_00n, 600)` is one year at 6%.
 *
 * Rounds once, at the end of the year, on the whole bucket. Compounding a rounded figure is how a
 * balance drifts over thirty steps, but a projection has to report a real balance each year, so the
 * rounding cannot be deferred the way `carryBucketsForward` defers it. The difference is that this
 * reports balances and that one reports ratios.
 */
export function grow(amountCents: bigint, basisPoints: number): bigint {
  return scaleSigned(amountCents, 10_000n + BigInt(basisPoints), 10_000n)
}

/**
 * The gross withdrawal needed to net `netCents` after tax at `rateBasisPoints`.
 *
 * Withdrawing exactly what is needed and *then* paying tax on it leaves the bill unfunded, so the
 * year silently comes up short — the plan looks like it holds and does not. Grossing up analytically
 * is exact for a flat rate, and avoids the iterate-until-it-converges loop a naive model needs.
 */
export function grossUpForTax(netCents: bigint, rateBasisPoints: number): bigint {
  if (rateBasisPoints <= 0) return netCents

  /*
   * A 100% rate has no finite gross-up: no withdrawal nets anything. Returning the net unchanged
   * would quietly model a tax-free withdrawal, so this refuses instead. It is not reachable from
   * the UI, and an assumption that absurd deserves to stop rather than be interpreted.
   */
  if (rateBasisPoints >= 10_000) {
    throw new RangeError('grossUpForTax: an effective rate of 100% or more has no gross-up')
  }

  return scaleSigned(netCents, 10_000n, 10_000n - BigInt(rateBasisPoints))
}
