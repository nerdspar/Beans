import { daysBetween, parseDecimalToCents, type IsoDate, type ParsedRow } from '@beans/shared'
import type { HouseholdContext } from '../repositories/household-context.js'

/**
 * The seam between imported and synced history.
 *
 * Imported history and the SimpleFIN window overlap, and the same transaction appears in both with
 * different descriptions — `TRADER JOE'S #452` from one, `Trader Joes` from the other. Matching on
 * text is hopeless.
 *
 * So overlap is detected on **amount and date proximity**, and every match is **proposed for manual
 * confirmation**. Never silently merged, never silently duplicated: silently merging loses a real
 * transaction that happened to look like another, and silently duplicating inflates spending in a
 * way nobody notices until the totals are questioned months later.
 */

/**
 * Mirrors the storage shape in staging.ts: the amount is a decimal string, because JSON cannot
 * carry a bigint and a JSON number would lose precision.
 */
type StoredRow = Omit<ParsedRow, 'amountCents'> & { amount: string }

function fromStoredRow(stored: StoredRow): ParsedRow {
  const { amount, ...rest } = stored
  return { ...rest, amountCents: parseDecimalToCents(amount) }
}

/** A transaction takes a few days to post, so imported and synced dates rarely align exactly. */
const MAX_DAY_DISTANCE = 4

export type SeamCandidate = {
  importRowId: string
  rowNumber: number
  transactionId: string
  /** Both sides, so a human can judge rather than trust a score. */
  importedDescription: string
  syncedDescription: string
  importedDate: IsoDate
  syncedDate: IsoDate
  amountCents: bigint
  dayDistance: number
  /** 0–100. Ranking only — it never decides anything on its own. */
  confidence: number
}

/**
 * Finds probable duplicates between staged rows and existing synced transactions.
 *
 * Amount equality is required rather than approximated. Two transactions of $52.40 and $52.41 four
 * days apart are far more likely to be two real purchases than one duplicated — and **loosening
 * this is exactly how mortgage payments would start matching**, since a payment leaves checking as
 * one amount and reduces the mortgage by only the principal portion. Do not fuzzy-match amounts.
 */
export async function findSeamCandidates(
  context: HouseholdContext,
  importId: string,
): Promise<SeamCandidate[]> {
  const staged = await context.client.query<{
    id: string
    row_number: number
    parsed: Buffer
    target_account_id: string | null
  }>(
    `select id, row_number, parsed, target_account_id
       from import_rows
      where import_id = $1 and status = 'pending' and parsed is not null
      order by row_number`,
    [importId],
  )

  if (staged.rows.length === 0) {
    return []
  }

  const rows = staged.rows.map((row) => ({
    id: row.id,
    rowNumber: row.row_number,
    accountId: row.target_account_id,
    parsed: fromStoredRow(context.cipher.decryptJson<StoredRow>(row.parsed)),
  }))

  const dates = rows.map((row) => row.parsed.date).sort()
  const earliest = dates[0] as IsoDate
  const latest = dates.at(-1) as IsoDate

  // Only synced transactions can be duplicates of an import. Two imported rows matching each other
  // is a separate concern and not what the seam is about.
  const synced = await context.client.query<{
    id: string
    account_id: string
    posted_date: IsoDate
    amount: Buffer
    description: Buffer | null
  }>(
    `select id, account_id, posted_date, amount, description
       from transactions
      where source = 'synced' and status = 'active'
        and posted_date between $1 and $2`,
    [shiftDate(earliest, -MAX_DAY_DISTANCE), shiftDate(latest, MAX_DAY_DISTANCE)],
  )

  /** Indexed by account and exact amount — the only two things that must match. */
  const byKey = new Map<
    string,
    Array<{ id: string; date: IsoDate; description: string; taken: boolean }>
  >()

  for (const row of synced.rows) {
    const amount = context.cipher.decryptMoney(row.amount)
    const key = `${row.account_id}:${amount}`
    const entry = {
      id: row.id,
      date: row.posted_date,
      description: row.description === null ? '' : context.cipher.decryptText(row.description),
      taken: false,
    }
    byKey.set(key, [...(byKey.get(key) ?? []), entry])
  }

  const candidates: SeamCandidate[] = []

  for (const row of rows) {
    if (row.accountId === null) continue

    const key = `${row.accountId}:${row.parsed.amountCents}`
    const possible = byKey.get(key)
    if (possible === undefined) continue

    // Nearest unclaimed transaction wins. Claiming prevents two imported rows from both matching
    // the same synced transaction, which would leave one of them wrongly skipped.
    let best: (typeof possible)[number] | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (const entry of possible) {
      if (entry.taken) continue
      const distance = Math.abs(daysBetween(row.parsed.date, entry.date))
      if (distance <= MAX_DAY_DISTANCE && distance < bestDistance) {
        best = entry
        bestDistance = distance
      }
    }

    if (best === null) continue
    best.taken = true

    candidates.push({
      importRowId: row.id,
      rowNumber: row.rowNumber,
      transactionId: best.id,
      importedDescription: row.parsed.description,
      syncedDescription: best.description,
      importedDate: row.parsed.date,
      syncedDate: best.date,
      amountCents: row.parsed.amountCents,
      dayDistance: bestDistance,
      // Same-day is near-certain; four days apart is worth a second look. Ranking only.
      confidence: Math.max(0, 100 - bestDistance * 20),
    })
  }

  return candidates
}

/**
 * Records the user's decisions.
 *
 * Confirmed rows are linked to the transaction they duplicate and skipped at commit. Rejected rows
 * import normally — the user is saying these really are two separate transactions.
 */
export async function confirmSeamMatches(
  context: HouseholdContext,
  decisions: ReadonlyArray<{ importRowId: string; transactionId: string; confirmed: boolean }>,
): Promise<{ confirmed: number; rejected: number }> {
  let confirmed = 0
  let rejected = 0

  for (const decision of decisions) {
    if (decision.confirmed) {
      await context.client.query(
        'update import_rows set match_transaction_id = $1 where id = $2 and household_id = $3',
        [decision.transactionId, decision.importRowId, context.householdId],
      )
      confirmed += 1
    } else {
      await context.client.query(
        'update import_rows set match_transaction_id = null where id = $1 and household_id = $2',
        [decision.importRowId, context.householdId],
      )
      rejected += 1
    }
  }

  return { confirmed, rejected }
}

/**
 * Establishes the cutover: imported data owns everything before it, synced data everything after.
 *
 * Set to the day after the latest imported transaction, which is where synced coverage takes over.
 * Recording it is what lets reconstruction know which side owns which period rather than having to
 * infer it from what happens to be present.
 */
export async function setImportCutover(
  context: HouseholdContext,
  accountId: string,
  cutover: IsoDate,
): Promise<void> {
  await context.client.query(
    'update accounts set import_cutover_date = $1 where id = $2 and household_id = $3',
    [cutover, accountId, context.householdId],
  )
}

function shiftDate(date: IsoDate, days: number): IsoDate {
  const millis = Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000
  return new Date(millis).toISOString().slice(0, 10)
}
