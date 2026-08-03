/**
 * Parsing decimal money strings into integer minor units (cents).
 *
 * This is the single most safety-critical module in Beans. Read ARCHITECTURE.md §3 before
 * changing anything here.
 *
 * The rules, restated because breaking them corrupts data silently:
 *   - Money is `bigint` cents. Never a float, never `parseFloat`.
 *   - SimpleFIN returns amounts as decimal *strings*. They arrive here as strings and leave as
 *     bigint. At no point is a JavaScript `number` involved.
 */

/** Thrown when an input cannot be parsed. The message includes the offending input. */
export class MoneyParseError extends Error {
  override readonly name = 'MoneyParseError'

  constructor(input: string, reason: string) {
    super(`Cannot parse ${JSON.stringify(input)} as money: ${reason}`)
  }
}

/**
 * Guards against pathological input. Real amounts are far shorter than this; anything longer is
 * malformed or hostile, and rejecting early keeps regex backtracking bounded.
 */
const MAX_INPUT_LENGTH = 32

/** Plain digits: `-1234`, `1234.5`, `0.005`. */
const WITHOUT_SEPARATORS = /^([+-]?)(\d+)(?:\.(\d+))?$/

/**
 * US-style thousands grouping: `1,234.56`. Groups after the first must be exactly three digits.
 *
 * That strictness is deliberate. It makes a European decimal comma (`1,5` meaning one and a half)
 * a parse *error* rather than silently reading as fifteen dollars. Beans assumes USD in v1; a
 * wrong-locale amount must fail loudly, not quietly.
 */
const WITH_SEPARATORS = /^([+-]?)(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/

/**
 * Parses a decimal money string into integer cents.
 *
 * Accepts an optional sign, optional US thousands separators, an optional fractional part, and
 * surrounding whitespace. Rejects everything else — currency symbols, parentheses-for-negative,
 * bare `.50`, and trailing `1.` all throw.
 *
 * More than two decimal places rounds **half away from zero** (the standard commercial
 * convention): `0.005` → `1n`, `-0.005` → `-1n`, `0.0049` → `0n`. Truncating instead would
 * silently lose money.
 *
 * CSV import will meet messier input than this (`$1,234.56`, `(45.00)`). That belongs in a
 * normalization step that strips decoration and then delegates here. Do not add a second parser
 * with its own number handling — two parsers eventually disagree.
 *
 * @throws {MoneyParseError} if the input is not a well-formed decimal amount.
 */
export function parseDecimalToCents(input: string): bigint {
  if (typeof input !== 'string') {
    throw new MoneyParseError(String(input), 'expected a string')
  }

  const trimmed = input.trim()

  if (trimmed.length === 0) {
    throw new MoneyParseError(input, 'empty')
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new MoneyParseError(input, `longer than ${MAX_INPUT_LENGTH} characters`)
  }

  const pattern = trimmed.includes(',') ? WITH_SEPARATORS : WITHOUT_SEPARATORS
  const match = pattern.exec(trimmed)

  if (match === null) {
    throw new MoneyParseError(input, 'not a well-formed decimal amount')
  }

  // Regex guarantees groups 1 and 2 are present; group 3 is optional.
  const sign = match[1] ?? ''
  const wholeDigits = (match[2] ?? '').replaceAll(',', '')
  const fraction = match[3] ?? ''

  // Pad to at least two digits so the slice below is always well defined.
  const centsDigits = `${fraction}00`.slice(0, 2)

  let magnitude = BigInt(wholeDigits) * 100n + BigInt(centsDigits)

  // Round half away from zero. Checking only the third digit is correct for this rule: a third
  // digit of exactly 5 means the remainder is >= one half, and anything below 5 means it is less.
  if (fraction.length > 2) {
    const thirdDigit = fraction[2]
    if (thirdDigit !== undefined && thirdDigit >= '5') {
      magnitude += 1n
    }
  }

  return sign === '-' ? -magnitude : magnitude
}
