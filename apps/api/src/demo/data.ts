import { addDays, type IsoDate } from '@beans/shared'

/**
 * The shape of a household worth showing somebody.
 *
 * Pure data and pure functions — no database, no clock, no randomness that is not seeded. The seeder
 * turns this into rows; keeping the two apart means the interesting decisions (what a believable
 * household looks like) are readable without wading through SQL.
 *
 * **Deterministic on purpose.** Re-seeding produces the identical household, so a demo that somebody
 * has been shown does not quietly become a different one, and a bug found in it can be reproduced.
 */

/**
 * A tiny seeded generator.
 *
 * `Math.random` would make every re-seed a different household — fine for a screenshot, useless for
 * "the chart looked wrong, can you reproduce it". mulberry32: short, well-distributed enough for
 * jitter on amounts, and reproducible from an integer.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type DemoAccountKind =
  | 'checking'
  | 'savings'
  | 'credit'
  | 'brokerage'
  | 'retirement'
  | 'mortgage'
  | 'student-loan'
  | 'house'

export type DemoAccount = {
  key: DemoAccountKind
  name: string
  institution: string
  type: 'depository' | 'credit' | 'investment' | 'mortgage' | 'loan' | 'other_asset'
  mask: string | null
  taxTreatment: 'taxable' | 'traditional' | 'roth' | 'none'
  /** Signed to Beans' convention: liabilities negative, assets positive. */
  currentBalanceCents: bigint
  isManual: boolean
  /** Present when the account has been paid off and closed. */
  closedOn?: IsoDate
}

/**
 * A household with something to show on every screen.
 *
 * Chosen so nothing is a degenerate case: two people's income, a card that carries a balance, a
 * mortgage that pays down, a student loan that finishes mid-history, investments across taxable and
 * tax-deferred, and a house that only a manual balance can describe.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: 'checking',
    name: 'Everyday Checking',
    institution: 'First Meridian Bank',
    type: 'depository',
    mask: '4021',
    taxTreatment: 'none',
    currentBalanceCents: 8_412_37n,
    isManual: false,
  },
  {
    key: 'savings',
    name: 'Emergency Fund',
    institution: 'First Meridian Bank',
    type: 'depository',
    mask: '7788',
    taxTreatment: 'none',
    currentBalanceCents: 24_180_00n,
    isManual: false,
  },
  {
    key: 'credit',
    name: 'Everyday Rewards Card',
    institution: 'Northgate Card Services',
    type: 'credit',
    mask: '9930',
    taxTreatment: 'none',
    currentBalanceCents: -2_284_63n,
    isManual: false,
  },
  {
    key: 'brokerage',
    name: 'Joint Brokerage',
    institution: 'Harborline Investments',
    type: 'investment',
    mask: '3312',
    taxTreatment: 'taxable',
    currentBalanceCents: 142_900_00n,
    isManual: false,
  },
  {
    key: 'retirement',
    name: 'Workplace 401(k)',
    institution: 'Harborline Investments',
    type: 'investment',
    mask: '8845',
    taxTreatment: 'traditional',
    currentBalanceCents: 318_450_00n,
    isManual: false,
  },
  {
    key: 'mortgage',
    name: 'Home Mortgage',
    institution: 'Cascade Home Loans',
    type: 'mortgage',
    mask: '1170',
    taxTreatment: 'none',
    currentBalanceCents: -281_640_00n,
    isManual: false,
  },
  {
    /*
     * Still outstanding, and visibly paying down.
     *
     * It was modelled as paid off, which left the loan section showing $0.00 — technically right
     * and indistinguishable from an account that failed to load. A balance that shrinks month by
     * month is the thing worth showing, and it gives the liabilities side of net worth something
     * other than a mortgage.
     */
    key: 'student-loan',
    name: 'Graduate Loan',
    institution: 'Meridian Student Lending',
    type: 'loan',
    mask: '6204',
    taxTreatment: 'none',
    currentBalanceCents: -14_280_00n,
    isManual: false,
  },
  {
    /* Only a person can say what a house is worth, which is what manual accounts are for. */
    key: 'house',
    name: 'Home',
    /*
     * The address, where a synced account would name its bank.
     *
     * "Manual" said only what the account already says elsewhere, and read as a placeholder nobody
     * had filled in — which for the one account a person types themselves is the wrong impression.
     */
    institution: '42 Apple Road',
    type: 'other_asset',
    mask: null,
    taxTreatment: 'none',
    currentBalanceCents: 512_000_00n,
    isManual: true,
  },
]

export type DemoRecurring = {
  account: DemoAccountKind
  payee: string
  description: string
  category: string
  /** Signed to Beans' convention. Positive adds to net worth. */
  amountCents: bigint
  /** Day of month it lands on. */
  day: number
  /** Jitter applied to the amount, as a fraction. Zero for anything genuinely fixed. */
  variance: number
}

/** The rhythm of a month: what arrives, what leaves, and when. */
export const DEMO_RECURRING: readonly DemoRecurring[] = [
  { account: 'checking', payee: 'Ridgeway Analytics', description: 'RIDGEWAY ANALYTICS PAYROLL', category: 'Paycheck', amountCents: 4_850_00n, day: 15, variance: 0 },
  { account: 'checking', payee: 'Ridgeway Analytics', description: 'RIDGEWAY ANALYTICS PAYROLL', category: 'Paycheck', amountCents: 4_850_00n, day: 30, variance: 0 },
  { account: 'checking', payee: 'Halcyon Design Co', description: 'HALCYON DESIGN DIRECT DEP', category: 'Paycheck', amountCents: 3_120_00n, day: 1, variance: 0 },

  { account: 'checking', payee: 'Cascade Home Loans', description: 'CASCADE HOME LOANS MTG PMT', category: 'Mortgage', amountCents: -2_310_00n, day: 3, variance: 0 },
  { account: 'checking', payee: 'Metro Water & Power', description: 'METRO WATER POWER AUTOPAY', category: 'Utilities', amountCents: -186_00n, day: 8, variance: 0.22 },
  { account: 'checking', payee: 'Fiberline Internet', description: 'FIBERLINE INTERNET RECURRING', category: 'Utilities', amountCents: -79_99n, day: 12, variance: 0 },
  { account: 'checking', payee: 'Cobalt Mutual', description: 'COBALT MUTUAL AUTO INS', category: 'Insurance', amountCents: -142_50n, day: 20, variance: 0 },

  { account: 'credit', payee: 'Greenfield Market', description: 'GREENFIELD MKT #221', category: 'Groceries', amountCents: -168_40n, day: 4, variance: 0.3 },
  { account: 'credit', payee: 'Greenfield Market', description: 'GREENFIELD MKT #221', category: 'Groceries', amountCents: -151_20n, day: 18, variance: 0.3 },
  { account: 'credit', payee: 'Northwind Fuel', description: 'NORTHWIND FUEL 4471', category: 'Gas', amountCents: -58_00n, day: 9, variance: 0.25 },
  { account: 'credit', payee: 'Streamline+', description: 'STREAMLINE PLUS SUBSCR', category: 'Subscriptions', amountCents: -17_99n, day: 6, variance: 0 },
  { account: 'credit', payee: 'Verdant Coffee', description: 'VERDANT COFFEE ROASTERS', category: 'Dining', amountCents: -22_40n, day: 11, variance: 0.4 },
  { account: 'credit', payee: 'Olive & Ash', description: 'OLIVE AND ASH BISTRO', category: 'Dining', amountCents: -94_00n, day: 22, variance: 0.35 },
  { account: 'credit', payee: 'Pinehill Pharmacy', description: 'PINEHILL PHARMACY 08', category: 'Health', amountCents: -41_60n, day: 26, variance: 0.4 },
]

export type DemoTransfer = {
  from: DemoAccountKind
  to: DemoAccountKind
  amountCents: bigint
  day: number
  payee: string
}

/**
 * Money moving between the household's own accounts.
 *
 * Included because transfers are the thing cash flow gets wrong when nobody models them: paired,
 * they cancel; unpaired, the same money reads as both income and spending. A demo without them
 * would make the cash flow screen look simpler than it is.
 */
export const DEMO_TRANSFERS: readonly DemoTransfer[] = [
  { from: 'checking', to: 'savings', amountCents: 60_000n, day: 16, payee: 'Transfer to Emergency Fund' },
  { from: 'checking', to: 'credit', amountCents: 45_000n, day: 24, payee: 'Card Payment' },
  { from: 'checking', to: 'brokerage', amountCents: 100_000n, day: 2, payee: 'Brokerage Contribution' },
]

export type DemoHolding = {
  account: DemoAccountKind
  symbol: string
  description: string
  shares: string
  /** Share of the account's value, so the holdings always add up to the balance shown. */
  weight: number
}

export const DEMO_HOLDINGS: readonly DemoHolding[] = [
  { account: 'brokerage', symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', shares: '312.4471', weight: 0.42 },
  { account: 'brokerage', symbol: 'VXUS', description: 'Vanguard Total International Stock ETF', shares: '486.10', weight: 0.21 },
  { account: 'brokerage', symbol: 'BND', description: 'Vanguard Total Bond Market ETF', shares: '204.88', weight: 0.14 },
  { account: 'brokerage', symbol: 'AAPL', description: 'Apple Inc', shares: '88.00', weight: 0.15 },
  { account: 'brokerage', symbol: 'VMFXX', description: 'Vanguard Federal Money Market', shares: '11480.00', weight: 0.08 },

  { account: 'retirement', symbol: 'FXAIX', description: 'Fidelity 500 Index Fund', shares: '1204.6612', weight: 0.55 },
  { account: 'retirement', symbol: 'FTIHX', description: 'Fidelity Total International Index', shares: '2210.40', weight: 0.22 },
  { account: 'retirement', symbol: 'FXNAX', description: 'Fidelity US Bond Index', shares: '3180.75', weight: 0.18 },
  { account: 'retirement', symbol: 'FDRXX', description: 'Fidelity Government Cash Reserves', shares: '15600.00', weight: 0.05 },
]

/** Occasional one-offs, so the history is not a metronome. */
export type DemoOneOff = {
  account: DemoAccountKind
  payee: string
  description: string
  category: string
  amountCents: bigint
  /** Months before the end of the history. */
  monthsAgo: number
  day: number
}

export const DEMO_ONE_OFFS: readonly DemoOneOff[] = [
  { account: 'credit', payee: 'Arbor Air', description: 'ARBOR AIR 0192884471', category: 'Travel', amountCents: -1_248_00n, monthsAgo: 4, day: 14 },
  { account: 'credit', payee: 'Seaside Rentals', description: 'SEASIDE RENTALS LLC', category: 'Travel', amountCents: -2_100_00n, monthsAgo: 4, day: 19 },
  { account: 'checking', payee: 'Ridgeway Analytics', description: 'RIDGEWAY ANALYTICS BONUS', category: 'Bonus', amountCents: 12_000_00n, monthsAgo: 7, day: 12 },
  { account: 'credit', payee: 'Halden Appliances', description: 'HALDEN APPLIANCE CO', category: 'Home', amountCents: -1_869_00n, monthsAgo: 11, day: 8 },
  { account: 'checking', payee: 'State Revenue Dept', description: 'STATE REVENUE REFUND', category: 'Other income', amountCents: 1_430_00n, monthsAgo: 15, day: 21 },
  { account: 'credit', payee: 'Fernway Motors', description: 'FERNWAY MOTORS SERVICE', category: 'Auto', amountCents: -742_00n, monthsAgo: 19, day: 5 },
]

/**
 * Every date a monthly item lands on, between two dates.
 *
 * Clamps to the last day of short months, so a 30th-of-the-month payday still lands in February
 * rather than silently vanishing from a twelfth of the history.
 */
export function monthlyDates(start: IsoDate, end: IsoDate, day: number): IsoDate[] {
  const dates: IsoDate[] = []

  let year = Number(start.slice(0, 4))
  let month = Number(start.slice(5, 7))

  while (true) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const landed = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`

    if (landed > end) break
    if (landed >= start) dates.push(landed)

    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return dates
}

/** Applies seeded jitter to an amount, keeping its sign and landing on whole cents. */
export function jitter(amountCents: bigint, variance: number, random: () => number): bigint {
  if (variance === 0) return amountCents

  const factor = 1 + (random() * 2 - 1) * variance
  return BigInt(Math.round(Number(amountCents) * factor))
}

/** The first of the month, `months` before `from`. */
export function monthsBefore(from: IsoDate, months: number): IsoDate {
  const year = Number(from.slice(0, 4))
  const month = Number(from.slice(5, 7)) - months

  const shiftedYear = year + Math.floor((month - 1) / 12)
  const shiftedMonth = ((((month - 1) % 12) + 12) % 12) + 1

  return `${shiftedYear}-${String(shiftedMonth).padStart(2, '0')}-01`
}

/** A date `days` before another, as a calendar date. */
export function daysBefore(from: IsoDate, days: number): IsoDate {
  return addDays(from, -days)
}
