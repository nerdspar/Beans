import { addDays, daysBetween, type IsoDate } from '../balance-history/dates.js'
import { isExcludedFromCashFlow } from '../cash-flow/transfers.js'
import { merchantKeyFor, merchantLabelFor } from './merchant.js'

/**
 * Finding the charges that come back on a schedule (ARCHITECTURE.md §20).
 *
 * Runs in the browser over the working set, for the same reason cash flow does: descriptions and
 * amounts are ciphertext in Postgres, so grouping charges by merchant cannot happen there.
 *
 * Two kinds come out, decided by whether the amount holds still:
 *
 * - **Subscriptions** — the same amount every time. Netflix, iCloud, a gym.
 * - **Bills** — on a schedule but the amount moves. Electricity, a phone plan with usage, or
 *   anything fixed but too large to be what people mean by a subscription, like rent.
 *
 * The person can move either way or hide a series entirely; that decision is passed in and wins.
 *
 * **Nothing here decides a sign.** Charges arrive negative, as spending does everywhere (§3.2), and
 * leave negative. Display negates.
 */

export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'
export type RecurringKind = 'subscription' | 'bill'
export type RecurringDecision = RecurringKind | 'ignored'

export type RecurringTransaction = {
  id: string
  accountId: string
  postedDate: IsoDate
  amountCents: bigint
  description: string | null
  payee: string | null
  pending: boolean
  status: 'active' | 'void'
  categoryKind?: 'income' | 'expense' | 'transfer' | undefined
  categorySlug?: string | undefined
}

export type RecurringSeries = {
  /**
   * What a decision is stored against. The merchant key, plus the amount when one merchant bills
   * several separate things — `apple.com@-299` and `apple.com@-999` are iCloud and Apple TV.
   */
  key: string
  label: string
  /** What the detector concluded, before any decision. */
  detectedKind: RecurringKind
  /** What to show it as: the person's decision if they made one, otherwise the detector's. */
  kind: RecurringKind
  decision: RecurringDecision | null
  cadence: RecurringCadence
  /** Whether the amount holds still. A moving amount is reported as typical, never as the price. */
  fixedAmount: boolean
  /** The latest charge when the amount is fixed; the median of recent ones when it moves. Negative. */
  amountCents: bigint
  /** {@link amountCents} over a year at this cadence. Negative. */
  annualCents: bigint
  firstDate: IsoDate
  lastDate: IsoDate
  /** When the next charge is due, if the pattern holds. May be in the past for a lapsed series. */
  nextDate: IsoDate
  /**
   * `lapsed` means a charge is overdue by more than the cadence allows for. Usually that is a
   * cancellation, sometimes a card that changed — the screen says what is known and no more.
   */
  status: 'active' | 'lapsed'
  /** The most recent change in a subscription's price. Null for bills, whose amount always moves. */
  priceChange: { fromCents: bigint; toCents: bigint; on: IsoDate } | null
  lastAccountId: string
  transactionIds: string[]
}

export type DetectRecurringOptions = {
  /** Passed in, never read from a clock, so a fixture means the same thing on any day. */
  today: IsoDate
  confirmedTransferIds: ReadonlySet<string>
  /** Keyed by {@link RecurringSeries.key}. */
  decisions?: ReadonlyMap<string, RecurringDecision>
}

type CadenceRule = {
  cadence: RecurringCadence
  /** Inclusive bounds on the gap between two charges. Months are 28–31 days; this allows for that. */
  minDays: number
  maxDays: number
  /** Fewer than this and a coincidence is as likely as a pattern. */
  minCharges: number
  perYear: bigint
  next: (from: IsoDate) => IsoDate
}

const CADENCES: readonly CadenceRule[] = [
  {
    cadence: 'weekly',
    minDays: 6,
    maxDays: 8,
    minCharges: 4,
    perYear: 52n,
    next: (d) => addDays(d, 7),
  },
  {
    cadence: 'biweekly',
    minDays: 12,
    maxDays: 16,
    minCharges: 3,
    perYear: 26n,
    next: (d) => addDays(d, 14),
  },
  {
    cadence: 'monthly',
    minDays: 26,
    maxDays: 35,
    minCharges: 3,
    perYear: 12n,
    next: (d) => addMonths(d, 1),
  },
  {
    cadence: 'quarterly',
    minDays: 84,
    maxDays: 98,
    minCharges: 3,
    perYear: 4n,
    next: (d) => addMonths(d, 3),
  },
  {
    cadence: 'annual',
    minDays: 350,
    maxDays: 380,
    minCharges: 2,
    perYear: 1n,
    next: (d) => addMonths(d, 12),
  },
]

/**
 * The share of gaps that must fit the cadence.
 *
 * Not all of them: a charge that slid to the next business day, or one month the bank posted late,
 * should not erase a two-year pattern. Three quarters keeps that tolerance while still rejecting a
 * merchant somebody merely visits often.
 */
const MIN_FIT = 0.75

/**
 * How late a charge can be before the series counts as lapsed, as a share of the cadence.
 *
 * Half a period: a monthly charge is lapsed after about 45 days without one, an annual one after
 * about a year and a half. Earlier than that and a slow-posting card would flicker in and out.
 */
const LAPSE_GRACE = 0.5

/**
 * Above this per charge, a fixed amount is presumed to be a bill rather than a subscription.
 *
 * Rent and a car payment are as fixed as Netflix, and listing them as subscriptions is the most
 * visible way this screen could be wrong. $250 sits above nearly every consumer subscription and
 * below nearly every housing payment. It is a default, not a verdict — the person can move a
 * series either way, and that decision is kept.
 */
const SUBSCRIPTION_CEILING_CENTS = 25_000n

/** Categories that say "bill" regardless of the amount. */
const BILL_CATEGORY_SLUGS = new Set([
  'housing',
  'housing-mortgage-rent',
  'housing-utilities',
  'insurance',
  'taxes',
])

/**
 * Categories where a variable amount on a schedule is a habit, not a bill.
 *
 * A weekly grocery run at the same shop has a cadence and a moving amount, which is exactly the
 * shape of a utility bill. Fixed amounts in these categories still count — a meal-kit plan is a
 * subscription — but a moving one is not reported.
 */
const DISCRETIONARY_CATEGORY_SLUGS = new Set([
  'food',
  'food-groceries',
  'food-dining',
  'transport-fuel',
  'shopping',
  'travel',
])

/**
 * How far a bill's amount may range, as max ÷ min. Electricity doubling between spring and August
 * is normal; a factor of four is a merchant somebody simply spends at irregularly.
 */
const MAX_BILL_SPREAD = 3n

export function detectRecurring(
  transactions: readonly RecurringTransaction[],
  options: DetectRecurringOptions,
): RecurringSeries[] {
  const groups = new Map<string, RecurringTransaction[]>()

  for (const transaction of transactions) {
    if (transaction.amountCents >= 0n || transaction.pending) continue
    // The same exclusion cash flow uses (§9): a card payment recurs monthly and is not a bill.
    if (isExcludedFromCashFlow(transaction, options.confirmedTransferIds)) continue

    const key = merchantKeyFor(transaction.payee, transaction.description)
    if (key === null) continue

    const group = groups.get(key)
    if (group === undefined) groups.set(key, [transaction])
    else group.push(transaction)
  }

  const series: RecurringSeries[] = []

  for (const [key, group] of groups) {
    const charges = [...group].sort(byDateThenId)

    // The whole merchant first: one subscription whose price changed is still one subscription.
    const whole = describe(key, charges, options)
    if (whole !== null) {
      series.push(whole)
      continue
    }

    /*
     * Then each amount on its own. One merchant string often bills several unrelated things —
     * `APPLE.COM/BILL` is iCloud, Apple TV and a game subscription on different days, and
     * `AMAZON` is Prime among a hundred one-off orders. Together they look irregular; separately
     * each is a clean monthly series.
     */
    const byAmount = new Map<bigint, RecurringTransaction[]>()
    for (const charge of charges) {
      const bucket = byAmount.get(charge.amountCents)
      if (bucket === undefined) byAmount.set(charge.amountCents, [charge])
      else bucket.push(charge)
    }

    for (const [amount, bucket] of byAmount) {
      const found = describe(`${key}@${amount}`, bucket, options)
      if (found !== null) series.push(found)
    }
  }

  return series.sort(
    (left, right) =>
      // Largest yearly cost first: what is worth knowing about comes before what is not.
      compareBigint(left.annualCents, right.annualCents) || left.label.localeCompare(right.label),
  )
}

function describe(
  key: string,
  charges: readonly RecurringTransaction[],
  options: DetectRecurringOptions,
): RecurringSeries | null {
  const rule = fitCadence(charges)
  if (rule === null) return null

  const first = charges[0]
  const last = charges[charges.length - 1]
  if (first === undefined || last === undefined) return null

  const amounts = charges.map((charge) => charge.amountCents)
  const fixed = isFixedAmount(amounts)

  if (!fixed) {
    if (DISCRETIONARY_CATEGORY_SLUGS.has(last.categorySlug ?? '')) return null
    if (!isBillShaped(rule, amounts)) return null
  }

  const amountCents = fixed ? last.amountCents : median(amounts.slice(-6))
  const detectedKind: RecurringKind =
    fixed &&
    -amountCents <= SUBSCRIPTION_CEILING_CENTS &&
    !BILL_CATEGORY_SLUGS.has(last.categorySlug ?? '')
      ? 'subscription'
      : 'bill'

  const decision = options.decisions?.get(key) ?? null
  const nextDate = rule.next(last.postedDate)
  const overdueBy = daysBetween(nextDate, options.today)
  const period = (rule.minDays + rule.maxDays) / 2

  return {
    key,
    label: merchantLabelFor(last.payee, key.replace(/@-?\d+$/, '')),
    detectedKind,
    kind: decision === 'subscription' || decision === 'bill' ? decision : detectedKind,
    decision,
    cadence: rule.cadence,
    fixedAmount: fixed,
    amountCents,
    annualCents: amountCents * rule.perYear,
    firstDate: first.postedDate,
    lastDate: last.postedDate,
    nextDate,
    status: overdueBy > period * LAPSE_GRACE ? 'lapsed' : 'active',
    priceChange: fixed ? latestPriceChange(charges) : null,
    lastAccountId: last.accountId,
    transactionIds: charges.map((charge) => charge.id),
  }
}

/** The cadence these charges keep, or null if they keep none. */
function fitCadence(charges: readonly RecurringTransaction[]): CadenceRule | null {
  const gaps: number[] = []
  for (let index = 1; index < charges.length; index += 1) {
    const previous = charges[index - 1]
    const current = charges[index]
    if (previous === undefined || current === undefined) continue
    gaps.push(daysBetween(previous.postedDate, current.postedDate))
  }
  if (gaps.length === 0) return null

  for (const rule of CADENCES) {
    if (charges.length < rule.minCharges) continue

    const fits = gaps.filter((gap) => gap >= rule.minDays && gap <= rule.maxDays).length
    // The latest gap must fit too: a series that used to be monthly and is now erratic is not
    // something to forecast a next charge from.
    const latest = gaps[gaps.length - 1] ?? 0
    if (fits / gaps.length >= MIN_FIT && latest >= rule.minDays && latest <= rule.maxDays) {
      return rule
    }
  }

  return null
}

/**
 * Whether the amount holds still, allowing for the occasional price change.
 *
 * Measured on consecutive pairs rather than distinct values: Netflix going from $15.49 to $17.99
 * is one change in a long run and still a fixed price. A utility bill changes nearly every month.
 *
 * One change is always allowed, however short the run. An annual plan seen twice, with a price
 * rise between, is a subscription that got dearer — not a bill.
 */
function isFixedAmount(amounts: readonly bigint[]): boolean {
  let changes = 0
  for (let index = 1; index < amounts.length; index += 1) {
    if (amounts[index] !== amounts[index - 1]) changes += 1
  }
  return changes <= Math.max(1, Math.floor((amounts.length - 1) * 0.2))
}

/** Bills are monthly or slower, and their amount stays within a believable range. */
function isBillShaped(rule: CadenceRule, amounts: readonly bigint[]): boolean {
  if (rule.cadence === 'weekly' || rule.cadence === 'biweekly') return false
  // Amounts are negative, so the largest magnitude is the minimum.
  const magnitudes = amounts.map((amount) => -amount)
  const smallest = magnitudes.reduce((a, b) => (b < a ? b : a))
  const largest = magnitudes.reduce((a, b) => (b > a ? b : a))
  return smallest > 0n && largest <= smallest * MAX_BILL_SPREAD
}

function latestPriceChange(
  charges: readonly RecurringTransaction[],
): RecurringSeries['priceChange'] {
  for (let index = charges.length - 1; index > 0; index -= 1) {
    const current = charges[index]
    const previous = charges[index - 1]
    if (current === undefined || previous === undefined) continue
    if (current.amountCents !== previous.amountCents) {
      return {
        fromCents: previous.amountCents,
        toCents: current.amountCents,
        on: current.postedDate,
      }
    }
  }
  return null
}

function median(values: readonly bigint[]): bigint {
  const sorted = [...values].sort(compareBigint)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0n
  if (sorted.length % 2 === 1) return upper
  const lower = sorted[middle - 1] ?? upper
  // Integer cents: a half-cent median rounds toward zero, which is a fraction of a cent of a typical.
  return (lower + upper) / 2n
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function byDateThenId(left: RecurringTransaction, right: RecurringTransaction): number {
  if (left.postedDate !== right.postedDate) return left.postedDate < right.postedDate ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Calendar months forward, clamped to the end of a shorter month — a charge on 31 January is next
 * due on 28 February, not 3 March.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [yearText, monthText, dayText] = date.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1 + months
  const day = Number(dayText)

  const targetYear = year + Math.floor(monthIndex / 12)
  const targetMonth = ((monthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()

  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(day, lastDay))}`
}
