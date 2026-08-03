import { formatCents, isLiabilitySection, type NetWorthSection } from '@beans/shared'
import type { SeriesPoint } from '../charts/AreaChart.js'

/**
 * Turning stored amounts into what a person should see.
 *
 * Storage signs everything so it adds directly to net worth: liabilities are negative
 * (ARCHITECTURE.md §3.2). That is right for arithmetic and wrong for reading.
 *
 * A mortgage stored as −$828,870 becoming −$818,100 is the debt shrinking. Plotted raw, the line
 * **rises** — technically the value increased, but it reads as the mortgage growing, which is the
 * opposite of what happened. Nobody thinks of their mortgage as a negative number getting closer to
 * zero; they think of it as an amount owed, going down.
 *
 * So a liability section is charted as the **magnitude owed**, and paying it down slopes downward.
 * The underlying amounts are untouched — this is presentation, applied at the edge, and net worth
 * arithmetic never sees it.
 */

/**
 * Prepares a section's series for charting.
 *
 * Liabilities are flipped to their magnitude. Assets and household net worth are shown as stored,
 * because a genuinely negative net worth **should** read as negative rather than being hidden.
 */
export function toChartSeries(
  series: readonly SeriesPoint[],
  section: NetWorthSection | 'household',
): SeriesPoint[] {
  if (section === 'household' || !isLiabilitySection(section)) {
    return [...series]
  }

  // Applies to every liability section alike — credit card, loan, mortgage, other liabilities.
  return series.map((point) => ({
    date: point.date,
    value: point.value < 0n ? -point.value : point.value,
  }))
}

export type ChangeDescription = {
  /** The amount, already formatted. */
  amount: string
  /** Phrasing that makes the direction unambiguous without relying on a sign. */
  text: string
  /** Whether this moved in the household's favour. Drives colour, never wording. */
  favourable: boolean
}

/**
 * Describes a change over the selected range.
 *
 * Words rather than a bare signed number, because for a liability the sign alone is genuinely
 * ambiguous: `−$9,790` could mean the debt fell by that much, or that net worth did. "Paid down"
 * and "borrowed" cannot be misread.
 *
 * **Never funny about a number moving the wrong way.** Debt increasing and net worth falling are
 * both stated plainly — no commiseration, no encouragement, no joke.
 */
export function describeChange(
  changeCents: bigint,
  section: NetWorthSection | 'household',
): ChangeDescription {
  const magnitude = changeCents < 0n ? -changeCents : changeCents
  const amount = formatCents(magnitude)

  if (section !== 'household' && isLiabilitySection(section)) {
    // Stored liabilities are negative, so a *rising* stored value means the debt shrank.
    const paidDown = changeCents > 0n
    return {
      amount,
      text: changeCents === 0n ? 'No change' : paidDown ? `${amount} paid down` : `${amount} added`,
      favourable: paidDown,
    }
  }

  const grew = changeCents > 0n
  return {
    amount,
    text:
      changeCents === 0n
        ? 'No change'
        : grew
          ? `${formatCents(changeCents, { signDisplay: 'exceptZero' })}`
          : `${formatCents(changeCents)}`,
    favourable: grew,
  }
}

/**
 * The headline figure for a section.
 *
 * **Liabilities always display negative.** A debt is money that subtracts from what the household
 * has, and showing `$818,100` for a mortgage invites reading it as something owned. The stored
 * value is already negative, so this is simply the stored value.
 *
 * Note this is independent of the *plot*, which uses magnitude so the area is tall when the debt is
 * large. The two agree once the axis is labelled — see {@link formatAxisValue}.
 */
export function formatSectionTotal(
  totalCents: bigint,
  _section: NetWorthSection | 'household',
): string {
  return formatCents(totalCents)
}

/**
 * Formats one axis label.
 *
 * Liability series are plotted as magnitudes, so the tick values arriving here are positive. They
 * are negated for display, which is what reconciles the two halves of the design:
 *
 * - the **area** is tall when the debt is large, and shrinks as it is paid down
 * - the **labels** read `-$828K` at the top through `-$818K` at the bottom, so every number on
 *   screen is negative and unmistakably a debt
 *
 * Which means the axis descends toward zero rather than away from it. That is the right way round
 * for a debt: nobody pictures a mortgage as a bar that grows as they pay it off.
 */
export function formatAxisValue(
  cents: bigint,
  section: NetWorthSection | 'household',
  fractionDigits = 2,
): string {
  const display =
    section !== 'household' && isLiabilitySection(section) && cents > 0n ? -cents : cents

  return formatCents(display, { compact: true, compactFractionDigits: fractionDigits })
}
