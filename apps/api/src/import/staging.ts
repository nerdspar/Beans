import {
  centsToDecimalString,
  detectDateFormat,
  parseDecimalToCents,
  hasBlockingProblem,
  parseImportRow,
  validateMapping,
  type ColumnMapping,
  type DateFormat,
  type ImportKind,
  type ImportPreset,
  type ParsedRow,
} from '@beans/shared'
import type { HouseholdContext } from '../repositories/household-context.js'
import { columnSamples, type ParsedCsv } from './csv.js'

/**
 * Staging, committing and reversing an import.
 *
 * **Nothing touches the real tables until the user has seen what will happen.** Rows are parsed
 * into `import_rows` first, previewed, then committed as a unit — and an import can be reversed as
 * a unit for thirty days afterwards.
 *
 * That is not ceremony. A five-year export is tens of thousands of transactions; discovering
 * afterwards that the date format was read backwards, or that every amount is sign-flipped, is not
 * something anyone should have to unpick by hand.
 */

export class ImportError extends Error {
  override readonly name = 'ImportError'
}

/**
 * A parsed row as stored in `import_rows`.
 *
 * The amount is a **decimal string**, not a bigint — `JSON.stringify` cannot serialize a bigint at
 * all, and a JSON number would be an IEEE-754 double and lose precision. Same rule as every other
 * boundary money crosses in this app.
 */
type StoredRow = Omit<ParsedRow, 'amountCents'> & { amount: string }

function toStored(row: ParsedRow): StoredRow {
  const { amountCents, ...rest } = row
  return { ...rest, amount: centsToDecimalString(amountCents) }
}

function fromStored(stored: StoredRow): ParsedRow {
  const { amount, ...rest } = stored
  // Round-trips through the same strict parser the rest of the app uses.
  return { ...rest, amountCents: parseDecimalToCents(amount) }
}

export type StageOptions = {
  csv: ParsedCsv
  mapping: readonly ColumnMapping[]
  preset: ImportPreset
  kind: ImportKind
  /** Used for every row when the file names no account. Ignored when `accountMap` is in play. */
  targetAccountId?: string | undefined
  /** Maps each account name found in the file to a Beans account. */
  accountMap?: ReadonlyArray<{ value: string; accountId: string }> | undefined
  originalFilename: string
  /** Overrides detection, for a column that is genuinely ambiguous. */
  dateFormat?: DateFormat
}

/** Case- and whitespace-insensitive, matching how the values were collected at inspect time. */
function accountKey(value: string): string {
  return value.trim().toLowerCase()
}

export type StageResult = {
  importId: string
  rowCount: number
  parsedCount: number
  failedCount: number
  dateFormat: DateFormat
  /** Blocking problems, if any. When present nothing was staged. */
  problems: ReturnType<typeof validateMapping>
}

/**
 * Parses and stages every row.
 *
 * A row that cannot be parsed is staged as `failed` with its reason rather than dropped — a silent
 * drop in a file of thirty thousand rows is invisible, and the count not matching is the only clue
 * anyone would get.
 */
export async function stageImport(
  context: HouseholdContext,
  options: StageOptions,
): Promise<StageResult> {
  const { csv, mapping, preset, kind, targetAccountId, originalFilename } = options

  /*
   * How each row finds its account.
   *
   * A single export routinely covers every account a household has — the Empower file names the
   * institution and account on every row. Staging used to stamp one `targetAccountId` onto all of
   * them, so a multi-account file imported cleanly with every transaction in the wrong place. The
   * per-row column has always existed in `import_rows`; only the value written was constant.
   *
   * When the file names accounts, resolution is **strict**: a row whose account was not mapped is
   * staged as failed and named in the preview. Falling back to a default account for unmapped rows
   * would reintroduce exactly the silent misfiling this replaces — the failure has to be visible.
   */
  const accountColumn = mapping.find((column) => column.role === 'account')
  const accountMap = new Map(
    (options.accountMap ?? []).map((entry) => [accountKey(entry.value), entry.accountId]),
  )
  const routeByAccountColumn = accountColumn !== undefined && accountMap.size > 0

  const problems = validateMapping(mapping, kind)
  if (hasBlockingProblem(problems)) {
    return {
      importId: '',
      rowCount: 0,
      parsedCount: 0,
      failedCount: 0,
      dateFormat: 'unrecognized',
      problems,
    }
  }

  const dateColumn = mapping.find((column) => column.role === 'date')
  const dateFormat =
    options.dateFormat ?? detectDateFormat(columnSamples(csv.rows, dateColumn?.columnIndex ?? 0))

  if (dateFormat === 'ambiguous' || dateFormat === 'unrecognized') {
    // Surfaced rather than guessed. Reading the format backwards shifts every date by up to eleven
    // months while producing a file that imports perfectly cleanly.
    return {
      importId: '',
      rowCount: csv.rows.length,
      parsedCount: 0,
      failedCount: 0,
      dateFormat,
      problems: [
        {
          severity: 'error',
          message:
            dateFormat === 'ambiguous'
              ? 'The date column could be month-first or day-first. Choose which explicitly.'
              : 'The date column could not be read. Check the column mapping.',
        },
      ],
    }
  }

  const importResult = await context.client.query<{ id: string }>(
    `insert into imports (
       household_id, created_by_user_id, source_preset, kind, status,
       original_filename, delimiter, mapping, row_count
     ) values ($1,$2,$3,$4,'staged',$5,$6,$7,$8) returning id`,
    [
      context.householdId,
      context.userId,
      preset.id,
      kind,
      context.cipher.encryptText(originalFilename),
      csv.delimiter,
      // Structure, not account data, so plaintext.
      JSON.stringify({ mapping, dateFormat, amountConvention: preset.amountConvention }),
      csv.rows.length,
    ],
  )

  const importId = importResult.rows[0]?.id
  if (importId === undefined) {
    throw new ImportError('Failed to create the import')
  }

  let parsedCount = 0
  let failedCount = 0

  for (const [index, cells] of csv.rows.entries()) {
    const result = parseImportRow(cells, { mapping, preset, dateFormat })

    let rowAccountId: string | null = targetAccountId ?? null
    let unmappedAccount: string | null = null

    if (routeByAccountColumn) {
      const named = result.ok ? result.row.account : (cells[accountColumn.columnIndex]?.trim() ?? '')
      rowAccountId = named === null || named === '' ? null : (accountMap.get(accountKey(named)) ?? null)
      if (rowAccountId === null) unmappedAccount = named === '' ? null : named
    }

    // An unroutable row fails loudly here rather than being dropped at commit, where the only trace
    // would have been a count that did not add up.
    const failedReason = !result.ok
      ? result.reason
      : rowAccountId === null
        ? unmappedAccount === null
          ? 'No account named in this row'
          : `No account is mapped to “${unmappedAccount}”`
        : null

    if (failedReason === null) {
      parsedCount += 1
    } else {
      failedCount += 1
    }

    await context.client.query(
      `insert into import_rows (
         household_id, import_id, row_number, raw, parsed, target_account_id, status, status_reason
       ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        context.householdId,
        importId,
        index + 1,
        // Both encrypted: staged rows are transaction data in every respect except that they have
        // not been committed yet.
        context.cipher.encryptJson(cells),
        result.ok ? context.cipher.encryptJson(toStored(result.row)) : null,
        rowAccountId,
        failedReason === null ? 'pending' : 'failed',
        failedReason,
      ],
    )
  }

  return {
    importId,
    rowCount: csv.rows.length,
    parsedCount,
    failedCount,
    dateFormat,
    problems,
  }
}

export type PreviewRow = {
  rowNumber: number
  status: string
  statusReason: string | null
  parsed: ParsedRow | null
  raw: string[]
}

/** The preview. Shows what will happen, including the rows that will not. */
export async function previewImport(
  context: HouseholdContext,
  importId: string,
  limit = 50,
): Promise<{ rows: PreviewRow[]; totalRows: number; failedRows: number }> {
  const rows = await context.client.query<{
    row_number: number
    status: string
    status_reason: string | null
    raw: Buffer | null
    parsed: Buffer | null
  }>(
    `select row_number, status, status_reason, raw, parsed
       from import_rows where import_id = $1 order by row_number limit $2`,
    [importId, limit],
  )

  const counts = await context.client.query<{ total: string; failed: string }>(
    `select count(*)::text as total,
            count(*) filter (where status = 'failed')::text as failed
       from import_rows where import_id = $1`,
    [importId],
  )

  return {
    rows: rows.rows.map((row) => ({
      rowNumber: row.row_number,
      status: row.status,
      statusReason: row.status_reason,
      raw: row.raw === null ? [] : context.cipher.decryptJson<string[]>(row.raw),
      parsed:
        row.parsed === null ? null : fromStored(context.cipher.decryptJson<StoredRow>(row.parsed)),
    })),
    totalRows: Number(counts.rows[0]?.total ?? 0),
    failedRows: Number(counts.rows[0]?.failed ?? 0),
  }
}

/** Thirty days, after which `import_rows` are purged and reversal becomes impossible. */
const REVERSIBLE_DAYS = 30

/**
 * Commits a staged import.
 *
 * Every created transaction carries `import_id`, which is what makes reversal a single delete
 * rather than a reconciliation problem.
 *
 * Rows already matched to an existing synced transaction are **skipped**, not inserted — that
 * confirmation is what prevents the seam from double-counting.
 */
export async function commitImport(
  context: HouseholdContext,
  importId: string,
  now: Date = new Date(),
): Promise<{ committed: number; skipped: number }> {
  const status = await loadImportStatus(context, importId)
  if (status !== 'staged') {
    throw new ImportError(`This import is ${status} and cannot be committed again`)
  }

  const rows = await context.client.query<{
    id: string
    parsed: Buffer
    target_account_id: string | null
    match_transaction_id: string | null
  }>(
    `select id, parsed, target_account_id, match_transaction_id
       from import_rows
      where import_id = $1 and status = 'pending' and parsed is not null
      order by row_number`,
    [importId],
  )

  let committed = 0
  let skipped = 0

  for (const row of rows.rows) {
    if (row.target_account_id === null) {
      skipped += 1
      continue
    }

    if (row.match_transaction_id !== null) {
      // A confirmed duplicate of a synced transaction. Importing it would double-count.
      await context.client.query(
        `update import_rows set status = 'skipped', status_reason = 'Matched an existing transaction' where id = $1`,
        [row.id],
      )
      skipped += 1
      continue
    }

    const parsed = fromStored(context.cipher.decryptJson<StoredRow>(row.parsed))

    const inserted = await context.client.query<{ id: string }>(
      `insert into transactions (
         household_id, account_id, posted_date, amount, description, payee, memo,
         status, source, import_id
       ) values ($1,$2,$3,$4,$5,$6,$7,'active','imported',$8) returning id`,
      [
        context.householdId,
        row.target_account_id,
        parsed.date,
        context.cipher.encryptMoney(parsed.amountCents),
        context.cipher.encryptText(parsed.description),
        context.cipher.encryptTextOrNull(parsed.payee),
        context.cipher.encryptTextOrNull(parsed.memo),
        importId,
      ],
    )

    await context.client.query(
      `update import_rows set status = 'imported', result_transaction_id = $1 where id = $2`,
      [inserted.rows[0]?.id ?? null, row.id],
    )
    committed += 1
  }

  const reversibleUntil = new Date(now.getTime() + REVERSIBLE_DAYS * 24 * 60 * 60 * 1000)

  await context.client.query(
    `update imports
        set status = 'committed', committed_at = $1, committed_row_count = $2, reversible_until = $3
      where id = $4`,
    [now, committed, reversibleUntil, importId],
  )

  return { committed, skipped }
}

/**
 * Reverses a committed import.
 *
 * Deletes exactly what it created, identified by `import_id`. Tombstones are written so delta sync
 * can carry the removal to clients rather than leaving them holding rows the server no longer has.
 */
export async function reverseImport(
  context: HouseholdContext,
  importId: string,
  now: Date = new Date(),
): Promise<{ reversed: number }> {
  const record = await context.client.query<{ status: string; reversible_until: Date | null }>(
    'select status, reversible_until from imports where id = $1',
    [importId],
  )

  const row = record.rows[0]
  if (row === undefined) {
    throw new ImportError('Import not found')
  }
  if (row.status !== 'committed') {
    throw new ImportError(`This import is ${row.status} and cannot be reversed`)
  }
  if (row.reversible_until !== null && row.reversible_until.getTime() < now.getTime()) {
    throw new ImportError(
      'The reversal window for this import has closed. Its staged rows have been purged.',
    )
  }

  const deleted = await context.client.query<{ id: string }>(
    `delete from transactions where import_id = $1 returning id`,
    [importId],
  )

  for (const transaction of deleted.rows) {
    await context.client.query(
      `insert into deletions (household_id, entity_type, entity_id, deleted_at)
       values ($1, 'transaction', $2, $3)`,
      [context.householdId, transaction.id, now],
    )
  }

  await context.client.query(
    `update imports set status = 'reversed', reversed_at = $1 where id = $2`,
    [now, importId],
  )

  await context.client.query(
    `update import_rows set status = 'pending', result_transaction_id = null where import_id = $1 and status = 'imported'`,
    [importId],
  )

  return { reversed: deleted.rowCount ?? 0 }
}

async function loadImportStatus(context: HouseholdContext, importId: string): Promise<string> {
  const result = await context.client.query<{ status: string }>(
    'select status from imports where id = $1',
    [importId],
  )

  const status = result.rows[0]?.status
  if (status === undefined) {
    throw new ImportError('Import not found')
  }
  return status
}
