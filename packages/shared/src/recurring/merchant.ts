/**
 * Turning a bank's description of a charge into a stable name for who was paid.
 *
 * The same subscription arrives as `NETFLIX.COM 866-579-7172 CA` one month and
 * `NETFLIX.COM 866-716-0414 CA` the next, or as `SQ *BLUE BOTTLE 0423 OAKLAND CA 04/03`. Grouping
 * charges by merchant is the whole of recurring detection, so this is the part that decides whether
 * it works. It does not need to produce a *pretty* name — it needs to produce the **same** string
 * for every charge from one merchant, and different strings for different merchants.
 *
 * What varies between charges is overwhelmingly digits — reference numbers, store numbers, phone
 * numbers, dates — plus processor prefixes and boilerplate. Those are stripped. What is left is
 * usually the merchant, sometimes followed by a city, and a city that is the same every month is
 * harmless.
 *
 * **The output is derived from payee text, so it is as sensitive as the payee.** It is encrypted
 * at rest wherever it is stored, and redacted from logs.
 */

/** Payment processors that prefix the real merchant: `SQ *`, `TST* `, `PAYPAL *`, `PP*`. */
const PROCESSOR_PREFIX = /^(?:sq|tst|sp|pp|paypal|py|ckc|dd|bt|ic|in|fs|pos)\s*\*\s*/

/** Card-network and bank boilerplate that says nothing about who was paid. */
const NOISE_WORDS = new Set([
  'ach',
  'autopay',
  'auto',
  'bill',
  'billpay',
  'card',
  'ccd',
  'checkcard',
  'co',
  'corp',
  'credit',
  'debit',
  'des',
  'entry',
  'id',
  'inc',
  'indn',
  'llc',
  'ltd',
  'mastercard',
  'payment',
  'pmt',
  'pos',
  'ppd',
  'preauthorized',
  'purchase',
  'recurring',
  'transaction',
  'visa',
  'web',
  'withdrawal',
])

const US_STATES = new Set(
  (
    'al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ' +
    'ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc'
  ).split(' '),
)

/**
 * Descriptions often trail off into junk that varies charge to charge — a location, a terminal,
 * a truncated reference. The merchant is at the front, so only the front is kept.
 */
const MAX_TOKENS = 4

function digitCount(token: string): number {
  let count = 0
  for (const character of token) {
    if (character >= '0' && character <= '9') count += 1
  }
  return count
}

/**
 * Whether a token is a reference number rather than part of a name.
 *
 * Three or more digits is the line. It drops store numbers (`0423`), reference codes (`2k3l4m9`)
 * and masked card numbers, while keeping the merchants whose names carry a digit or two —
 * `1password`, `23andme`, `24 hour fitness`, `7-eleven`.
 */
function isReference(token: string): boolean {
  return digitCount(token) >= 3 || /^x{2,}\d*$/.test(token)
}

/**
 * A stable grouping key for a charge's merchant, or null when nothing recognisable is left.
 *
 * The payee wins when there is one: when a provider sends a payee at all it is usually the clean
 * name, and the description the noisy one.
 */
export function merchantKeyFor(payee: string | null, description: string | null): string | null {
  const source = payee !== null && payee.trim() !== '' ? payee : description
  if (source === null) return null

  let text = source.toLowerCase()

  // Wells Fargo and others put the authorization date at the front of every line.
  text = text.replace(/purchase authorized on \d{1,2}\/\d{1,2}/g, ' ')
  // Dates anywhere: 04/03, 04/03/26, 4/3/2026.
  text = text.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
  // Phone numbers, which merchants rotate through: 866-579-7172, (866) 579 7172.
  text = text.replace(/\(?\b\d{3}\)?[-. ]?\d{3}[-. ]\d{4}\b/g, ' ')
  text = text.replace(/https?:\/\//g, '').replace(/\bwww\./g, '')
  text = text.trim().replace(PROCESSOR_PREFIX, '')

  const tokens = text
    // Dots survive so a domain stays one token (`netflix.com`); everything else separates.
    .split(/[^a-z0-9.&']+/)
    .map((token) => token.replace(/^[.']+|[.']+$/g, ''))
    .filter((token) => token !== '' && !isReference(token) && !NOISE_WORDS.has(token))

  // A trailing state code is location, not identity — and it is the piece most likely to differ
  // when the same merchant bills from another office. Kept when it is all there is.
  while (tokens.length > 1 && US_STATES.has(tokens[tokens.length - 1] ?? '')) {
    tokens.pop()
  }

  const key = tokens.slice(0, MAX_TOKENS).join(' ')
  return key === '' ? null : key
}

/**
 * Something readable to put on screen for a merchant.
 *
 * A payee is shown as the provider sent it. Without one the key is all there is, and a key is
 * lower case by construction, so it is title-cased — `netflix.com` reads better as `Netflix.com`
 * than as a shout or a whisper.
 */
export function merchantLabelFor(payee: string | null, key: string): string {
  if (payee !== null && payee.trim() !== '') return payee.trim()
  return key.replace(/(^|\s)([a-z])/g, (_match, space: string, letter: string) => {
    return space + letter.toUpperCase()
  })
}
