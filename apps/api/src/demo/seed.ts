import { addDays, toIsoDate, type IsoDate } from '@beans/shared'
import { rebuildHouseholdHistory } from '../balance-history/rebuild.js'
import { ensureDefaultCategories } from '../repositories/categories.js'
import type { HouseholdContext } from '../repositories/household-context.js'
import {
  DEMO_ACCOUNTS,
  DEMO_HOLDINGS,
  DEMO_ONE_OFFS,
  DEMO_RECURRING,
  DEMO_TRANSFERS,
  jitter,
  monthlyDates,
  monthsBefore,
  seededRandom,
  type DemoAccountKind,
} from './data.js'

/**
 * Fills the demo household with a life.
 *
 * **Writes transactions and lets the real pipeline do the rest.** Balance history is not fabricated
 * here — it is produced by `rebuildHouseholdHistory` from the transactions, exactly as it is for a
 * synced household. So the demo exercises reconstruction rather than illustrating it, and a bug in
 * that path shows up in the demo instead of hiding behind hand-written snapshots.
 *
 * Investments are the exception, necessarily: their value moves with the market, which no
 * transaction records, so their history is written as dated observations (§4). That is the same
 * shape a real provider supplies.
 *
 * Idempotent. Re-seeding clears the household's financial data first, so this can be run on a
 * schedule to undo whatever visitors have done to it.
 */

/** How much history the demo carries. Long enough for the range control to have something to say. */
const HISTORY_MONTHS = 30

/** Fixed, so a demo somebody has been shown does not become a different one on the next reseed. */
const SEED = 20260805

export type SeedResult = {
  accounts: number
  transactions: number
  holdings: number
}

export async function seedDemoHousehold(
  context: HouseholdContext,
  today: IsoDate,
): Promise<SeedResult> {
  await clearHousehold(context)
  await ensureDefaultCategories(context)

  const random = seededRandom(SEED)
  const start = monthsBefore(today, HISTORY_MONTHS)

  const accountIds = await createAccounts(context, today)
  const categories = await loadCategoryIds(context)

  let transactions = 0

  // ── The monthly rhythm ──────────────────────────────────────────────────────
  for (const item of DEMO_RECURRING) {
    const accountId = accountIds.get(item.account)
    if (accountId === undefined) continue

    for (const date of monthlyDates(start, today, item.day)) {
      await insertTransaction(context, {
        accountId,
        date,
        amountCents: jitter(item.amountCents, item.variance, random),
        payee: item.payee,
        description: item.description,
        categoryId: categories.get(item.category) ?? null,
      })
      transactions += 1
    }
  }

  // ── The things that happened once ───────────────────────────────────────────
  for (const item of DEMO_ONE_OFFS) {
    const accountId = accountIds.get(item.account)
    if (accountId === undefined) continue

    const month = monthsBefore(today, item.monthsAgo)
    const date = `${month.slice(0, 7)}-${String(item.day).padStart(2, '0')}`
    if (date < start || date > today) continue

    await insertTransaction(context, {
      accountId,
      date,
      amountCents: item.amountCents,
      payee: item.payee,
      description: item.description,
      categoryId: categories.get(item.category) ?? null,
    })
    transactions += 1
  }

  /*
   * Transfers, written as the pair they are.
   *
   * Both sides exist as real transactions on real accounts, because that is what a transfer is —
   * the matcher's job is to notice, and giving it only one side would mean demonstrating cash flow
   * against data that cannot exercise it.
   */
  for (const transfer of DEMO_TRANSFERS) {
    const from = accountIds.get(transfer.from)
    const to = accountIds.get(transfer.to)
    if (from === undefined || to === undefined) continue

    for (const date of monthlyDates(start, today, transfer.day)) {
      await insertTransaction(context, {
        accountId: from,
        date,
        amountCents: -transfer.amountCents,
        payee: transfer.payee,
        description: transfer.payee.toUpperCase(),
        categoryId: categories.get('Transfers') ?? null,
      })
      await insertTransaction(context, {
        accountId: to,
        date,
        amountCents: transfer.amountCents,
        payee: transfer.payee,
        description: transfer.payee.toUpperCase(),
        categoryId: categories.get('Transfers') ?? null,
      })
      transactions += 2
    }
  }

  // ── The loan that finishes ──────────────────────────────────────────────────
  await seedStudentLoan(context, accountIds, categories, start, today)

  // ── Investments, which no transaction can describe ──────────────────────────
  await seedInvestmentHistory(context, accountIds, start, today, random)
  const holdings = await seedHoldings(context, accountIds, today)

  // ── The manual account, kept up to date by hand ─────────────────────────────
  await seedManualBalances(context, accountIds, start, today)

  await rebuildHouseholdHistory(context, today)

  return { accounts: accountIds.size, transactions, holdings }
}

/**
 * Empties the household's financial data, leaving the household and its membership.
 *
 * Ordered by dependency rather than relying on cascades, so a table gaining a foreign key later
 * fails loudly here rather than leaving orphans in a demo nobody inspects closely.
 */
async function clearHousehold(context: HouseholdContext): Promise<void> {
  for (const table of [
    'holdings',
    'balance_snapshots',
    'transfer_matches',
    'import_rows',
    'imports',
    'transactions',
    'manual_balance_updates',
    'category_rules',
    'accounts',
    'connections',
    'institutions',
  ]) {
    await context.client.query(`delete from ${table} where household_id = $1`, [
      context.householdId,
    ])
  }
}

async function createAccounts(
  context: HouseholdContext,
  today: IsoDate,
): Promise<Map<DemoAccountKind, string>> {
  const ids = new Map<DemoAccountKind, string>()

  for (const account of DEMO_ACCOUNTS) {
    const institution = await context.client.query<{ id: string }>(
      `insert into institutions (household_id, name) values ($1, $2) returning id`,
      [context.householdId, context.cipher.encryptText(account.institution)],
    )

    const result = await context.client.query<{ id: string }>(
      `insert into accounts (
         household_id, institution_id, type, display_name, mask, currency,
         current_balance, balance_as_of, is_manual, confirmed_at, tax_treatment,
         is_closed, closed_on
       ) values ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$7,$9,$10,$11)
       returning id`,
      [
        context.householdId,
        institution.rows[0]?.id ?? null,
        account.type,
        context.cipher.encryptText(account.name),
        account.mask === null ? null : context.cipher.encryptText(account.mask),
        context.cipher.encryptMoney(account.currentBalanceCents),
        new Date(`${today}T12:00:00Z`),
        account.isManual,
        account.taxTreatment,
        account.closedOn !== undefined,
        account.closedOn ?? null,
      ],
    )

    const id = result.rows[0]?.id
    if (id !== undefined) ids.set(account.key, id)
  }

  return ids
}

async function loadCategoryIds(context: HouseholdContext): Promise<Map<string, string>> {
  const result = await context.client.query<{ id: string; name: string }>(
    'select id, name from categories',
  )
  return new Map(result.rows.map((row) => [row.name, row.id]))
}

async function insertTransaction(
  context: HouseholdContext,
  input: {
    accountId: string
    date: IsoDate
    amountCents: bigint
    payee: string
    description: string
    categoryId: string | null
  },
): Promise<void> {
  await context.client.query(
    `insert into transactions (
       household_id, account_id, posted_date, amount, description, payee,
       status, source, category_id
     ) values ($1,$2,$3,$4,$5,$6,'active','synced',$7)`,
    [
      context.householdId,
      input.accountId,
      input.date,
      context.cipher.encryptMoney(input.amountCents),
      context.cipher.encryptText(input.description),
      context.cipher.encryptText(input.payee),
      input.categoryId,
    ],
  )
}

/**
 * A loan that is paid off partway through, so a liability visibly ends.
 *
 * Its balance is zero today, and reconstruction walks the payments backwards to show what was owed
 * — which is the same path a real paid-off loan takes, and worth demonstrating because it is the
 * one where a missing payment history shows as flat zero.
 */
async function seedStudentLoan(
  context: HouseholdContext,
  accountIds: Map<DemoAccountKind, string>,
  categories: Map<string, string>,
  start: IsoDate,
  today: IsoDate,
): Promise<void> {
  const accountId = accountIds.get('student-loan')
  if (accountId === undefined) return

  // Payments stop nine months back; the balance has been zero since.
  const lastPayment = monthsBefore(today, 9)

  for (const date of monthlyDates(start, lastPayment, 21)) {
    await insertTransaction(context, {
      accountId,
      date,
      // Positive on a liability: a payment moves the balance toward zero.
      amountCents: 612_00n,
      payee: 'Meridian Student Lending',
      description: 'MERIDIAN STUDENT LENDING PMT',
      categoryId: categories.get('Loan payment') ?? null,
    })
  }
}

/**
 * Investment history, as dated observations.
 *
 * Deliberately not derived from transactions: an investment balance moves with the market, and
 * nothing in a transaction record says how (§4). A gentle upward drift with a visible drawdown, so
 * the portfolio screen has both a trend and a dip rather than a straight line nobody believes.
 */
async function seedInvestmentHistory(
  context: HouseholdContext,
  accountIds: Map<DemoAccountKind, string>,
  start: IsoDate,
  today: IsoDate,
  random: () => number,
): Promise<void> {
  for (const key of ['brokerage', 'retirement'] as const) {
    const accountId = accountIds.get(key)
    const account = DEMO_ACCOUNTS.find((candidate) => candidate.key === key)
    if (accountId === undefined || account === undefined) continue

    const dates = monthlyDates(start, today, 1)
    const months = dates.length

    for (const [index, date] of dates.entries()) {
      /*
       * Worked backwards from today's balance so the series *ends* exactly where the account says
       * it is. Building forwards from a guess would leave the last snapshot disagreeing with the
       * current balance, which is precisely the inconsistency the rebuild exists to catch.
       */
      const monthsBack = months - 1 - index
      const drift = Math.pow(1.0072, -monthsBack)
      const dip = monthsBack > 6 && monthsBack < 10 ? 0.93 : 1
      const noise = 1 + (random() * 2 - 1) * 0.012

      const value = BigInt(
        Math.round(Number(account.currentBalanceCents) * drift * dip * noise),
      )

      await context.client.query(
        `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
         values ($1,$2,$3,$4,'observed')
         on conflict (account_id, as_of_date) do update set balance = excluded.balance`,
        [context.householdId, accountId, date, context.cipher.encryptMoney(value)],
      )
    }

    await context.client.query(
      'update accounts set coverage_start_date = $1 where id = $2',
      [dates[0] ?? start, accountId],
    )
  }
}

async function seedHoldings(
  context: HouseholdContext,
  accountIds: Map<DemoAccountKind, string>,
  today: IsoDate,
): Promise<number> {
  let written = 0

  /*
   * Two dates, so every position has a prior observation to be measured against.
   *
   * With one, the holdings screen can only say "New" for everything — accurate, and it shows
   * nothing. Three days apart rather than one, because that is what a household actually holds:
   * providers publish settled balances and weekends never move.
   *
   * `addDays` rather than arithmetic on the string — subtracting from the day component walks off
   * the start of a month, which is a silent off-by-a-month on the 1st and 2nd.
   */
  const dates: IsoDate[] = [addDays(today, -3), today]

  for (const [index, date] of dates.entries()) {
    for (const holding of DEMO_HOLDINGS) {
      const accountId = accountIds.get(holding.account)
      const account = DEMO_ACCOUNTS.find((candidate) => candidate.key === holding.account)
      if (accountId === undefined || account === undefined) continue

      // The earlier reading is slightly lower, so a day's move is a real number rather than zero.
      const scale = index === 0 ? 0.9915 : 1
      const value = BigInt(
        Math.round(Number(account.currentBalanceCents) * holding.weight * scale),
      )

      await context.client.query(
        `insert into holdings (
           household_id, account_id, as_of_date, provider_holding_id,
           symbol, description, shares, market_value, currency
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'USD')
         on conflict (account_id, provider_holding_id, as_of_date) do nothing`,
        [
          context.householdId,
          accountId,
          date,
          `${holding.account}-${holding.symbol}`,
          context.cipher.encryptText(holding.symbol),
          context.cipher.encryptText(holding.description),
          context.cipher.encryptText(holding.shares),
          context.cipher.encryptMoney(value),
        ],
      )
      written += 1
    }
  }

  await context.client.query(
    `update accounts set holdings_checked_at = $1 where household_id = $2 and type = 'investment'`,
    [new Date(`${today}T12:00:00Z`), context.householdId],
  )

  return written
}

/** A house, valued a few times a year — which is the only way anybody knows what one is worth. */
async function seedManualBalances(
  context: HouseholdContext,
  accountIds: Map<DemoAccountKind, string>,
  start: IsoDate,
  today: IsoDate,
): Promise<void> {
  const accountId = accountIds.get('house')
  const account = DEMO_ACCOUNTS.find((candidate) => candidate.key === 'house')
  if (accountId === undefined || account === undefined) return

  const dates = monthlyDates(start, today, 1).filter((_, index) => index % 6 === 0)

  for (const [index, date] of dates.entries()) {
    // Worked backwards from today's value, so the last entry matches the account exactly.
    const stepsBack = dates.length - 1 - index
    const value = BigInt(
      Math.round(Number(account.currentBalanceCents) * Math.pow(1.018, -stepsBack)),
    )

    await context.client.query(
      `insert into manual_balance_updates (household_id, account_id, effective_date, balance)
       values ($1,$2,$3,$4)
       on conflict (account_id, effective_date) do update set balance = excluded.balance`,
      [context.householdId, accountId, date, context.cipher.encryptMoney(value)],
    )
  }

  await context.client.query(
    'update accounts set coverage_start_date = $1 where id = $2',
    [dates[0] ?? start, accountId],
  )
}

/** Today, as the seeder's caller sees it. Separated so a test can pin it. */
export function seedToday(now: Date = new Date()): IsoDate {
  return toIsoDate(now)
}
