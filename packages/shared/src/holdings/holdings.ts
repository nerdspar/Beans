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

/** Decimal places shown for a share count. Two matches how brokerages print them. */
const SHARE_DECIMALS = 2

/**
 * A share count, shortened for display.
 *
 * Providers send whatever precision they hold — `262.834`, `13.7601`, sometimes eight places on a
 * fractional-share position — and the tail is noise in a list somebody is scanning.
 *
 * **Truncated, not rounded.** Rounding up would show more shares than are held, and a quantity that
 * overstates a position is the wrong direction to be wrong in. Trailing zeros go too, so a whole
 * number reads as `255` rather than `255.00`.
 *
 * Returns the original string when it is not a number, rather than inventing one. Some institutions
 * put text where a count belongs, and passing it through is better than showing `NaN`.
 */
export function formatShares(shares: string): string {
  const trimmed = shares.trim()
  if (!/^-?\d*\.?\d+$/.test(trimmed)) return shares

  const negative = trimmed.startsWith('-')
  const digits = negative ? trimmed.slice(1) : trimmed
  const [rawWhole = '', fraction = ''] = digits.split('.')

  // `'.5'.split('.')` yields an empty string rather than undefined, so the destructuring default
  // never fires and a bare `.5` would render as `.5`.
  const whole = rawWhole === '' ? '0' : rawWhole

  const kept = fraction.slice(0, SHARE_DECIMALS).replace(/0+$/, '')
  const body = kept === '' ? whole : `${whole}.${kept}`

  return negative ? `-${body}` : body
}

/**
 * Working precision for summing share counts.
 *
 * Eight places is past anything a broker reports — fractional-share programs run to six — and the
 * arithmetic is exact `bigint` at that scale rather than floating point. Share counts are not money
 * and are never summed *into* money, but they are still summed, and a sum is exactly where binary
 * floating point starts producing 98.96999999999998.
 */
const SHARE_PRECISION = 8

/** A decimal share string as an integer scaled by {@link SHARE_PRECISION}, or null if unparseable. */
function sharesToScaled(value: string): bigint | null {
  const trimmed = value.trim()
  if (!/^-?\d*\.?\d+$/.test(trimmed)) return null

  const negative = trimmed.startsWith('-')
  const digits = negative ? trimmed.slice(1) : trimmed
  const [whole = '', fraction = ''] = digits.split('.')

  const padded = fraction.padEnd(SHARE_PRECISION, '0').slice(0, SHARE_PRECISION)
  const scaled = BigInt(`${whole === '' ? '0' : whole}${padded}`)

  return negative ? -scaled : scaled
}

function scaledToShares(scaled: bigint): string {
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(SHARE_PRECISION + 1, '0')

  const whole = digits.slice(0, digits.length - SHARE_PRECISION)
  const fraction = digits.slice(digits.length - SHARE_PRECISION).replace(/0+$/, '')
  const body = fraction === '' ? whole : `${whole}.${fraction}`

  return negative ? `-${body}` : body
}

/**
 * The same position held in several accounts, added up.
 *
 * Null when nothing in the group reported a count — one account reporting shares and another not is
 * a partial answer, and a total that silently omits the second would understate the position. In
 * that case the caller shows the value alone rather than a share count that is quietly wrong.
 */
export function sumShares(values: readonly (string | null)[]): string | null {
  const scaled: bigint[] = []

  for (const value of values) {
    if (value === null) continue
    const parsed = sharesToScaled(value)
    // A count that cannot be read is not zero. Refusing the whole sum beats reporting a short one.
    if (parsed === null) return null
    scaled.push(parsed)
  }

  if (scaled.length === 0) return null
  if (scaled.length !== values.length) return null

  return scaledToShares(scaled.reduce((total, value) => total + value, 0n))
}

export type GroupableHolding = {
  symbol: string | null
  description: string | null
  shares: string | null
  marketValueCents: bigint
  previousMarketValueCents: bigint | null
}

export type GroupedHolding = {
  /** The grouping key, uppercased. Falls back to the description where no symbol was reported. */
  key: string
  symbol: string | null
  description: string | null
  shares: string | null
  marketValueCents: bigint
  /** Null when *any* member lacked a prior observation — see below. */
  previousMarketValueCents: bigint | null
  /** How many accounts hold it. Above one, the row is a sum rather than a position. */
  accountCount: number
}

/**
 * The same security held across several accounts, collapsed into one row.
 *
 * Grouped on the **symbol**, uppercased, because that is the only field that identifies a security
 * rather than a provider's copy of one: the provider holding id is per-account by construction, and
 * descriptions differ between institutions for the same fund ("Vanguard FTSE Emerging Markets" and
 * "VANGUARD FTSE EMERG MKT ETF" are one holding). Positions with no symbol fall back to their
 * description, which keeps them separate rather than merging every unnamed cash sweep into one row.
 *
 * **The prior value is null unless every member has one.** A group where one account is a day behind
 * would otherwise show the change of a subset against the total of everything, which reads as a
 * plausible number and is not one.
 */
export function groupBySymbol(holdings: readonly GroupableHolding[]): GroupedHolding[] {
  const groups = new Map<string, GroupableHolding[]>()

  for (const holding of holdings) {
    const key = (holding.symbol ?? holding.description ?? '').trim().toUpperCase()
    if (key === '') continue
    groups.set(key, [...(groups.get(key) ?? []), holding])
  }

  const grouped = [...groups.entries()].map(([key, members]) => {
    const marketValueCents = members.reduce((total, member) => total + member.marketValueCents, 0n)

    const everyPrevious = members.every((member) => member.previousMarketValueCents !== null)
    const previousMarketValueCents = everyPrevious
      ? members.reduce((total, member) => total + (member.previousMarketValueCents ?? 0n), 0n)
      : null

    return {
      key,
      symbol: members.find((member) => member.symbol !== null)?.symbol ?? null,
      description: members.find((member) => member.description !== null)?.description ?? null,
      shares: sumShares(members.map((member) => member.shares)),
      marketValueCents,
      previousMarketValueCents,
      accountCount: members.length,
    }
  })

  // Largest first, matching every other value-ordered list in the app.
  return grouped.sort((left, right) =>
    right.marketValueCents > left.marketValueCents
      ? 1
      : right.marketValueCents < left.marketValueCents
        ? -1
        : 0,
  )
}

export type IndexPoint = {
  date: string
  /** Cumulative return since the first point, in basis points. Zero on day one by construction. */
  basisPoints: bigint
}

/**
 * The portfolio's own performance, indexed to zero at the start of the window.
 *
 * A personal index answers "how did my money do", which is a different question from "what is it
 * worth" — and the difference is entirely money paid in. A chart of raw value shows a contribution
 * as a jump indistinguishable from a good day, which is the failure this whole area keeps
 * producing. So each day's return is measured market-only and the days are **chain-linked**:
 *
 *     return(d) = (close − open − flow) / (open + flow)
 *     index(d)  = (1 + index(d−1)) × (1 + return(d)) − 1
 *
 * Chained rather than summed because returns compound; adding daily percentages drifts from the
 * truth the moment the window is longer than a few weeks.
 *
 * **Where the provider reports no transactions the flow is zero and this degrades to plain percent
 * change.** That is the best available answer rather than a claim nothing was paid in, and it is
 * the same caveat the day figures carry — the caller states it.
 *
 * Basis points rather than a float so the result is exact and can be carried as a `bigint` through
 * the charting layer like every other value. A day whose opening exposure is zero contributes no
 * return: there is nothing to have earned on, and dividing would invent one.
 */
export function personalIndex(
  series: readonly { date: string; value: bigint }[],
  flowByDate: ReadonlyMap<string, bigint>,
): IndexPoint[] {
  if (series.length < 2) return []

  const points: IndexPoint[] = []
  let cumulative = 1

  for (const [index, point] of series.entries()) {
    if (index === 0) {
      points.push({ date: point.date, basisPoints: 0n })
      continue
    }

    const previous = series[index - 1]
    if (previous === undefined) continue

    const flow = flowByDate.get(point.date) ?? 0n
    const exposed = previous.value + flow

    if (exposed !== 0n) {
      const gain = point.value - previous.value - flow
      cumulative *= 1 + Number(gain) / Number(exposed)
    }

    points.push({
      date: point.date,
      basisPoints: BigInt(Math.round((cumulative - 1) * 10_000)),
    })
  }

  return points
}
