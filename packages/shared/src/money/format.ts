/**
 * Rendering integer cents back out as strings.
 *
 * Everything here works from `bigint` end to end. Converting cents through a JavaScript `number`
 * would be exact only below 2^53 and is never necessary, so it never happens.
 */

/**
 * Converts integer cents to an exact decimal string, always with two decimal places.
 *
 * `123456n` → `"1234.56"`, `-5n` → `"-0.05"`, `0n` → `"0.00"`.
 *
 * This is the wire format for money crossing the API boundary. Money is never serialized as a
 * JSON number — JSON numbers are IEEE-754 doubles and lose precision above 2^53.
 */
export function centsToDecimalString(cents: bigint): string {
  const negative = cents < 0n
  const magnitude = negative ? -cents : cents

  const whole = magnitude / 100n
  const remainder = magnitude % 100n

  return `${negative ? '-' : ''}${whole}.${remainder.toString().padStart(2, '0')}`
}

export type FormatCentsOptions = {
  /** ISO 4217 code. v1 is USD throughout, but the parameter exists from day one. */
  currency?: string
  locale?: string
  /** When false, rounds to whole units for display. Does not change the underlying value. */
  showCents?: boolean
  /** Renders a leading `+` on positive values. For deltas, where direction is the point. */
  signDisplay?: 'auto' | 'exceptZero'
  /**
   * Abbreviates large values: `$2.6M`, `$824K`.
   *
   * For chart axes, where five full-precision labels stacked down the left edge are unreadable and
   * the exact figure is not the point — the axis conveys scale, and the precise number is shown
   * above the chart. Never use this where the amount itself is the information.
   */
  compact?: boolean
}

/**
 * `Intl.NumberFormat#format` accepts decimal strings as of ECMA-402 NumberFormat v3, which lets us
 * format an exact string rather than routing cents through a double. TypeScript's ES2023 lib does
 * not yet declare that overload, so the instance is narrowed to the shape we actually use.
 */
type StringNumberFormat = { format(value: string): string }

/**
 * Formats integer cents as localized currency: `123456n` → `"$1,234.56"`.
 *
 * Formatting is presentation only. It never feeds back into stored values, and a formatted string
 * is never parsed back into cents — `parseDecimalToCents` rejects currency symbols precisely so
 * that round trip cannot happen by accident.
 */
export function formatCents(cents: bigint, options: FormatCentsOptions = {}): string {
  const {
    currency = 'USD',
    locale = 'en-US',
    showCents = true,
    signDisplay = 'auto',
    compact = false,
  } = options

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    signDisplay,
    // Compact notation picks its own precision; forcing fraction digits alongside it produces
    // "$2.60M" where "$2.6M" is wanted.
    ...(compact
      ? { notation: 'compact' as const, maximumFractionDigits: 2 }
      : {
          minimumFractionDigits: showCents ? 2 : 0,
          maximumFractionDigits: showCents ? 2 : 0,
        }),
  }) as unknown as StringNumberFormat

  return formatter.format(centsToDecimalString(cents))
}
