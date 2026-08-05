/**
 * Arithmetic for a single position.
 *
 * Two things only, both of which have a wrong answer that looks right, which is why they live here
 * with tests rather than inline in a component.
 */

/**
 * What one share is worth, in cents.
 *
 * Derived rather than reported: SimpleFIN sends a market value and a share count and no price, so
 * the only way to show "88.47 @ $147.81" is to divide.
 *
 * **Display only.** The result is rounded to the cent and must never be multiplied back out to a
 * total — the market value is the authority on what the position is worth, and reconstructing it
 * from a rounded price would disagree with it by cents that grow with the share count.
 *
 * Null rather than zero when there is nothing to divide by. A fund with no share count is a real
 * thing (some cash positions report none) and "$0.00 per share" would be a lie about it.
 *
 * The share count is parsed as a float, which would be unforgivable for money and is fine here: it
 * is a quantity, never summed, and only ever feeds a figure already being rounded to the cent.
 */
export function pricePerShare(marketValueCents: bigint, shares: string | null): bigint | null {
  if (shares === null) return null

  const count = Number(shares)
  if (!Number.isFinite(count) || count === 0) return null

  return BigInt(Math.round(Number(marketValueCents) / count))
}

export type HoldingMove = {
  changeCents: bigint
  /** Null when there is nothing to measure against, rather than a zero that reads as "flat". */
  fraction: number | null
}

/**
 * What a position did between two observations.
 *
 * A plain difference, deliberately: unlike an account, a position has no transactions to net out.
 * Shares bought or sold change the market value, and there is no flow to subtract — which means a
 * position whose share count moved will show that as a change. Nothing here can tell the difference,
 * and pretending otherwise would be worse than the caller knowing it.
 *
 * Null when the position did not exist at the earlier observation. A holding bought yesterday has no
 * move, and showing its whole value as a gain would be the single most misleading number on the
 * screen.
 */
export function holdingMove(
  currentCents: bigint,
  previousCents: bigint | null | undefined,
): HoldingMove | null {
  if (previousCents === null || previousCents === undefined) return null

  const changeCents = currentCents - previousCents

  return {
    changeCents,
    fraction: previousCents === 0n ? null : Number(changeCents) / Number(previousCents),
  }
}
