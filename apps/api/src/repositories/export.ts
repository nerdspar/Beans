import { centsToDecimalString } from '@beans/shared'
import type { HouseholdContext } from './household-context.js'

/**
 * Everything a household has, as rows anybody can read.
 *
 * **This is the leaving feature, and that is the point of it.** The whole reason Beans exists is
 * that eight years of history sat in another app behind a one-month-at-a-time PDF export. Shipping
 * the same trap would be unforgivable, so the export is deliberately complete rather than
 * convenient: every account, every transaction, and — the part that actually matters — **one row
 * per account per day of balance history, including loans and investments**.
 *
 * That last one is what nothing else can reconstruct. Cash and credit balances can be walked
 * backwards from transactions; an investment balance cannot, because a share price moving is not
 * something anybody posts. If the daily snapshots are not in the export, that history is gone the
 * moment somebody leaves, and it cannot be rebuilt from anything else in the file.
 *
 * Decryption happens here, at the repository boundary, like every other read. What comes out is
 * plaintext by construction — see the route for what that means.
 */

export type ExportTable = {
  headers: readonly string[]
  rows: ReadonlyArray<readonly string[]>
}

/** Every account, including closed ones. A closed account held real money on real dates. */
export async function exportAccounts(context: HouseholdContext): Promise<ExportTable> {
  const result = await context.client.query<{
    id: string
    display_name: Buffer | null
    provider_name: Buffer | null
    institution_name: Buffer | null
    mask: Buffer | null
    type: string
    tax_treatment: string | null
    currency: string
    current_balance: Buffer | null
    available_balance: Buffer | null
    balance_as_of: string | null
    coverage_start_date: string | null
    is_manual: boolean
    is_shared: boolean
    is_closed: boolean
    closed_on: string | null
  }>(
    `select a.id, a.display_name, a.provider_name, a.mask, a.type, a.tax_treatment, a.currency,
            a.current_balance, a.available_balance, a.balance_as_of, a.coverage_start_date,
            a.is_manual, a.is_shared, a.is_closed, a.closed_on,
            i.name as institution_name
       from accounts a
       left join institutions i on i.id = a.institution_id
      order by a.type, a.id`,
  )

  return {
    headers: [
      'account_id',
      'name',
      'institution',
      'mask',
      'type',
      'tax_treatment',
      'currency',
      'current_balance',
      'available_balance',
      'balance_as_of',
      'coverage_start_date',
      'is_manual',
      'is_shared',
      'is_closed',
      'closed_on',
    ],
    rows: result.rows.map((row) => [
      row.id,
      accountName(context, row),
      context.cipher.decryptTextOrNull(row.institution_name) ?? '',
      context.cipher.decryptTextOrNull(row.mask) ?? '',
      row.type,
      row.tax_treatment ?? '',
      row.currency,
      moneyOrBlank(context, row.current_balance),
      moneyOrBlank(context, row.available_balance),
      row.balance_as_of ?? '',
      row.coverage_start_date ?? '',
      String(row.is_manual),
      String(row.is_shared),
      String(row.is_closed),
      row.closed_on ?? '',
    ]),
  }
}

/**
 * One row per account per day.
 *
 * The largest table by far — a decade across thirty accounts is around a hundred thousand rows —
 * and the one worth having. `source` is carried because a derived value and an observed one are not
 * the same claim, and anybody importing this elsewhere deserves to know which is which.
 */
export async function exportBalances(context: HouseholdContext): Promise<ExportTable> {
  const result = await context.client.query<{
    account_id: string
    display_name: Buffer | null
    provider_name: Buffer | null
    as_of_date: string
    balance: Buffer | null
    source: string
  }>(
    `select b.account_id, b.as_of_date, b.balance, b.source, a.display_name, a.provider_name
       from balance_snapshots b
       join accounts a on a.id = b.account_id
      order by b.as_of_date, b.account_id`,
  )

  return {
    headers: ['as_of_date', 'account_id', 'account_name', 'balance', 'source'],
    rows: result.rows.map((row) => [
      row.as_of_date,
      row.account_id,
      accountName(context, row),
      moneyOrBlank(context, row.balance),
      row.source,
    ]),
  }
}

/** Every transaction, voided ones included and marked — a void is a fact about what happened. */
export async function exportTransactions(context: HouseholdContext): Promise<ExportTable> {
  const result = await context.client.query<{
    id: string
    account_id: string
    display_name: Buffer | null
    provider_name: Buffer | null
    posted_date: string
    amount: Buffer | null
    description: Buffer | null
    payee: Buffer | null
    memo: Buffer | null
    category_name: string | null
    pending: boolean
    status: string
    source: string
  }>(
    `select t.id, t.account_id, t.posted_date, t.amount, t.description, t.payee, t.memo,
            t.pending, t.status, t.source,
            a.display_name, a.provider_name, c.name as category_name
       from transactions t
       join accounts a on a.id = t.account_id
       left join categories c on c.id = t.category_id
      order by t.posted_date, t.id`,
  )

  return {
    headers: [
      'posted_date',
      'account_id',
      'account_name',
      'amount',
      'description',
      'payee',
      'memo',
      'category',
      'pending',
      'status',
      'source',
      'transaction_id',
    ],
    rows: result.rows.map((row) => [
      row.posted_date,
      row.account_id,
      accountName(context, row),
      moneyOrBlank(context, row.amount),
      context.cipher.decryptTextOrNull(row.description) ?? '',
      context.cipher.decryptTextOrNull(row.payee) ?? '',
      context.cipher.decryptTextOrNull(row.memo) ?? '',
      row.category_name ?? '',
      String(row.pending),
      row.status,
      row.source,
      row.id,
    ]),
  }
}

/**
 * The name a person would recognise: theirs if they set one, the provider's otherwise.
 *
 * The same precedence the working set uses, so an account is called one thing on screen and the
 * same thing in the file. Providers publish names their own customers do not recognise — "Joint
 * (7E56)" — which is exactly why a rename exists and why it has to win here too.
 */
function accountName(
  context: HouseholdContext,
  row: { display_name: Buffer | null; provider_name: Buffer | null },
): string {
  return (
    context.cipher.decryptTextOrNull(row.display_name) ??
    context.cipher.decryptTextOrNull(row.provider_name) ??
    'Account'
  )
}

/**
 * A decimal string, or empty for a genuinely absent value.
 *
 * Empty rather than `0.00`: an account with no available balance reported is not an account with
 * nothing available, and writing a zero would turn a gap in what the provider sent into a figure
 * somebody could act on.
 */
function moneyOrBlank(context: HouseholdContext, value: Buffer | null): string {
  if (value === null) return ''
  return centsToDecimalString(context.cipher.decryptMoney(value))
}
