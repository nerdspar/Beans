import {
  carryForward,
  carryStale,
  checkReconstruction,
  mergeSeries,
  reconstructBackward,
  toIsoDate,
  type AccountType,
  type DailyBalance,
  type IsoDate,
} from '@beans/shared'
import type { HouseholdContext } from '../repositories/household-context.js'

/**
 * Rebuilding an account's daily balance series and persisting it.
 *
 * `balance_snapshots` is **derived output**, recomputable from scratch at any time — it is never
 * edited independently of the inputs that produce it (ARCHITECTURE.md §4.1). This module is the
 * only thing that writes it.
 *
 * The daily job runs for every account regardless of type, so derived, observed, imported and
 * carried history converge into one uniform daily series and every chart reads a single shape.
 */

/**
 * Types whose balance only moves when transactions post, so backward reconstruction is exact.
 *
 * Investment accounts are excluded on purpose: their value moves with the market, so subtracting
 * transactions from the current balance would produce a confident, smooth, wrong line.
 */
const RECONSTRUCTABLE: ReadonlySet<AccountType> = new Set<AccountType>([
  'depository',
  'credit',
  'loan',
  'mortgage',
])

export type RebuildResult = {
  accountId: string
  snapshotsWritten: number
  /** False when the derived series disagrees with the observed balance. See below. */
  consistent: boolean
  difference: bigint
  coverageStart: IsoDate | null
}

type AccountRow = {
  id: string
  type: AccountType
  is_manual: boolean
  current_balance: Buffer | null
  balance_as_of: Date | null
  coverage_start_date: IsoDate | null
  import_cutover_date: IsoDate | null
}

/**
 * Rebuilds one account's series from its inputs and writes it.
 *
 * Returns without writing when the account has no observed balance yet — an account confirmed but
 * never synced has nothing to derive from, and inventing a zero would put a fake account into
 * household net worth.
 */
export async function rebuildAccountHistory(
  context: HouseholdContext,
  accountId: string,
  today: IsoDate,
): Promise<RebuildResult> {
  const account = await loadAccount(context, accountId)

  const empty: RebuildResult = {
    accountId,
    snapshotsWritten: 0,
    consistent: true,
    difference: 0n,
    coverageStart: account?.coverage_start_date ?? null,
  }

  if (account === null || account.current_balance === null || account.balance_as_of === null) {
    return empty
  }

  const currentBalance = context.cipher.decryptMoney(account.current_balance)
  const balanceAsOf = toIsoDate(account.balance_as_of)
  const coverageStart = account.coverage_start_date

  if (coverageStart === null) {
    // Nothing has established how far back this account can be trusted, so there is no honest
    // series to draw. `ensureCoverageStart` sets it during sync.
    return empty
  }

  const series = account.is_manual
    ? await buildManualSeries(context, accountId, coverageStart, balanceAsOf)
    : RECONSTRUCTABLE.has(account.type)
      ? await buildDerivedSeries(context, account, currentBalance, balanceAsOf, coverageStart)
      : await buildObservedSeries(context, account, currentBalance, balanceAsOf, coverageStart)

  // A broken sync leaves the balance behind today. Carrying it forward keeps household net worth
  // summable, and the `carried` marker lets the UI say so rather than implying it was observed.
  const withCarry = carryStale(series, today)

  const written = await writeSnapshots(context, accountId, withCarry)

  /**
   * The consistency check exists for one specific failure: an institution reporting its balance and
   * its transactions in **opposite sign conventions** produces a perfectly smooth series that
   * drifts steadily from reality. Nothing errors, and the chart looks entirely plausible.
   *
   * Only meaningful for reconstructed series — an observed series trivially matches, since it was
   * built from the balance rather than derived from it.
   */
  const check =
    RECONSTRUCTABLE.has(account.type) && !account.is_manual
      ? checkReconstruction(series, currentBalance)
      : { consistent: true, difference: 0n }

  return {
    accountId,
    snapshotsWritten: written,
    consistent: check.consistent,
    difference: check.difference,
    coverageStart,
  }
}

/** Backward reconstruction, plus any imported history before the cutover. */
async function buildDerivedSeries(
  context: HouseholdContext,
  account: AccountRow,
  currentBalance: bigint,
  balanceAsOf: IsoDate,
  coverageStart: IsoDate,
): Promise<DailyBalance[]> {
  const transactions = await loadTransactions(context, account.id, coverageStart, balanceAsOf)

  const derived = reconstructBackward({
    currentBalanceCents: currentBalance,
    balanceAsOf,
    transactions,
    // Reconstruction starts at the cutover when imported history covers the earlier period —
    // imported data owns everything before it, synced data everything after.
    coverageStart: account.import_cutover_date ?? coverageStart,
  })

  if (account.import_cutover_date === null) {
    return derived
  }

  const imported = await loadImportedSnapshots(context, account.id, coverageStart)
  // Derived wins on the overlap day, so the seam has no gap and no double count.
  return mergeSeries(imported, derived)
}

/**
 * Forward observations, for investment accounts.
 *
 * Their history genuinely starts the day they were connected. Past values are unknowable — the
 * market moved, and no transaction record says how.
 */
async function buildObservedSeries(
  context: HouseholdContext,
  account: AccountRow,
  currentBalance: bigint,
  balanceAsOf: IsoDate,
  coverageStart: IsoDate,
): Promise<DailyBalance[]> {
  const existing = await loadObservedSnapshots(context, account.id, coverageStart)

  // Today's observation, which supersedes any snapshot already written for the same date.
  const observations = [...existing, { date: balanceAsOf, balanceCents: currentBalance }]

  const observed = carryForward(observations, coverageStart, balanceAsOf)

  if (account.import_cutover_date === null) {
    return observed
  }

  const imported = await loadImportedSnapshots(context, account.id, coverageStart)
  return mergeSeries(imported, observed)
}

/** Manual accounts: user-entered balances, held flat until the next entry. */
async function buildManualSeries(
  context: HouseholdContext,
  accountId: string,
  coverageStart: IsoDate,
  through: IsoDate,
): Promise<DailyBalance[]> {
  const result = await context.client.query<{ effective_date: IsoDate; balance: Buffer }>(
    'select effective_date, balance from manual_balance_updates where account_id = $1 order by effective_date',
    [accountId],
  )

  const observations = result.rows.map((row) => ({
    date: row.effective_date,
    balanceCents: context.cipher.decryptMoney(row.balance),
  }))

  return carryForward(observations, coverageStart, through)
}

async function loadAccount(
  context: HouseholdContext,
  accountId: string,
): Promise<AccountRow | null> {
  const result = await context.client.query<AccountRow>(
    `select id, type, is_manual, current_balance, balance_as_of, coverage_start_date,
            import_cutover_date
       from accounts where id = $1`,
    [accountId],
  )
  return result.rows[0] ?? null
}

/**
 * Transactions feeding reconstruction.
 *
 * Voided rows are excluded: a pending transaction that vanished without posting never happened, so
 * counting it would drift the entire series before its date.
 */
async function loadTransactions(
  context: HouseholdContext,
  accountId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<Array<{ date: IsoDate; amountCents: bigint }>> {
  const result = await context.client.query<{ posted_date: IsoDate; amount: Buffer }>(
    `select posted_date, amount
       from transactions
      where account_id = $1 and status = 'active' and posted_date between $2 and $3`,
    [accountId, from, to],
  )

  return result.rows.map((row) => ({
    date: row.posted_date,
    amountCents: context.cipher.decryptMoney(row.amount),
  }))
}

async function loadObservedSnapshots(
  context: HouseholdContext,
  accountId: string,
  from: IsoDate,
): Promise<Array<{ date: IsoDate; balanceCents: bigint }>> {
  const result = await context.client.query<{ as_of_date: IsoDate; balance: Buffer }>(
    `select as_of_date, balance from balance_snapshots
      where account_id = $1 and source = 'observed' and as_of_date >= $2
      order by as_of_date`,
    [accountId, from],
  )

  return result.rows.map((row) => ({
    date: row.as_of_date,
    balanceCents: context.cipher.decryptMoney(row.balance),
  }))
}

async function loadImportedSnapshots(
  context: HouseholdContext,
  accountId: string,
  from: IsoDate,
): Promise<DailyBalance[]> {
  const result = await context.client.query<{ as_of_date: IsoDate; balance: Buffer }>(
    `select as_of_date, balance from balance_snapshots
      where account_id = $1 and source = 'imported' and as_of_date >= $2
      order by as_of_date`,
    [accountId, from],
  )

  return result.rows.map((row) => ({
    date: row.as_of_date,
    balanceCents: context.cipher.decryptMoney(row.balance),
    source: 'imported' as const,
  }))
}

/**
 * Rows per statement.
 *
 * Postgres caps a statement at 65535 parameters and each row uses five, so the hard ceiling is
 * ~13000. Five hundred keeps statements small while cutting round trips by the same factor —
 * writing a year of history one row at a time against a database on the LAN is the difference
 * between a second and several minutes.
 */
const SNAPSHOT_BATCH_SIZE = 500

/**
 * Upserts a series.
 *
 * Reconstruction rewrites history whenever a late transaction posts, so this is an upsert rather
 * than an insert — and it deliberately touches only the days it was given. Days outside the
 * rebuilt range keep whatever they had, which is what lets imported history survive a resync.
 */
async function writeSnapshots(
  context: HouseholdContext,
  accountId: string,
  series: readonly DailyBalance[],
): Promise<number> {
  let written = 0

  for (let offset = 0; offset < series.length; offset += SNAPSHOT_BATCH_SIZE) {
    const batch = series.slice(offset, offset + SNAPSHOT_BATCH_SIZE)

    const values: unknown[] = []
    const tuples = batch.map((entry, index) => {
      const base = index * 5
      values.push(
        context.householdId,
        accountId,
        entry.date,
        context.cipher.encryptMoney(entry.balanceCents),
        entry.source,
      )
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
    })

    const result = await context.client.query(
      `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
       values ${tuples.join(', ')}
       on conflict (account_id, as_of_date) do update
         set balance = excluded.balance, source = excluded.source`,
      values,
    )

    written += result.rowCount ?? 0
  }

  return written
}

/**
 * Establishes how far back an account's history can be trusted.
 *
 * Set once, on the first sync that produces data, and never moved later — widening it afterwards
 * would claim knowledge of a period we never fetched, and the chart would extend backward into
 * invented history.
 *
 * For reconstructable accounts it is the start of the transaction window fetched. For investment
 * accounts it is the day they were connected, because nothing earlier is knowable.
 */
export async function ensureCoverageStart(
  context: HouseholdContext,
  accountId: string,
  windowStart: IsoDate,
): Promise<void> {
  await context.client.query(
    `update accounts
        set coverage_start_date = $1
      where id = $2 and coverage_start_date is null`,
    [windowStart, accountId],
  )
}

/** Rebuilds every account in the household. The daily job. */
export async function rebuildHouseholdHistory(
  context: HouseholdContext,
  today: IsoDate,
): Promise<RebuildResult[]> {
  const accounts = await context.client.query<{ id: string }>(
    `select id from accounts where is_closed = false and confirmed_at is not null`,
  )

  const results: RebuildResult[] = []
  for (const account of accounts.rows) {
    results.push(await rebuildAccountHistory(context, account.id, today))
  }

  return results
}
