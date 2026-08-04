import { z } from 'zod'

/**
 * The wire contract for the client working set (ARCHITECTURE.md §7).
 *
 * There is **one** data endpoint and it answers "everything that changed since cursor X", not
 * "page 3 of transactions". The client keeps the working set in IndexedDB and derives net worth,
 * sections, series, filtering and search from it locally — which it has to, because amounts and
 * descriptions are ciphertext in Postgres and cannot be summed, sorted or searched there.
 *
 * **Money crosses this boundary as a decimal string, never a JSON number.** JSON numbers are
 * IEEE-754 doubles and silently lose precision above 2^53 — a net worth in cents reaches that at
 * about $90 trillion, which sounds safe until an import fixture or a fat-fingered manual entry gets
 * there. The string costs nothing and removes the class of bug entirely.
 */

/** `-?\d+\.\d{2}` — cents, as a decimal string. */
const money = z.string().regex(/^-?\d+\.\d{2}$/, 'Money must be a decimal string with two places')
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')

export const accountTypeSchema = z.enum([
  'depository',
  'credit',
  'loan',
  'mortgage',
  'investment',
  'other_asset',
  'other_liability',
])

export const snapshotSourceSchema = z.enum(['derived', 'observed', 'imported', 'carried'])
export const connectionStatusSchema = z.enum(['healthy', 'stale', 'error'])

export const workingSetAccountSchema = z.object({
  id: z.string().uuid(),
  type: accountTypeSchema,
  /** Already resolved server-side: the user's name if they set one, otherwise the provider's. */
  name: z.string(),
  institutionName: z.string().nullable(),
  mask: z.string().nullable(),
  currency: z.string(),
  currentBalance: money.nullable(),
  availableBalance: money.nullable(),
  balanceAsOf: z.string().nullable(),
  isManual: z.boolean(),
  isClosed: z.boolean(),
  taxTreatment: z.string(),
  /**
   * Never draw a line to the left of this (ARCHITECTURE.md §4.3). The chart has to know where the
   * data genuinely starts, or it presents an absence of history as a flat balance.
   */
  coverageStartDate: isoDate.nullable(),

  /*
   * Connection health, denormalized onto the account.
   *
   * The client needs it per row to draw the dot and to decide what to recommend, and a connection
   * carries no other client-relevant state — sending a separate connections collection would mean
   * a join on the client for one enum and two timestamps. The access URL is never included, in any
   * form, partial or otherwise.
   */
  connectionStatus: connectionStatusSchema.nullable(),
  lastSuccessAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
})

export const workingSetCategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(['income', 'expense', 'transfer']),
  parentId: z.string().uuid().nullable(),
})

export const workingSetBalanceSchema = z.object({
  accountId: z.string().uuid(),
  asOfDate: isoDate,
  balance: money,
  source: snapshotSourceSchema,
})

export const workingSetTransactionSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  postedDate: isoDate,
  amount: money,
  description: z.string().nullable(),
  payee: z.string().nullable(),
  categoryId: z.string().uuid().nullable(),
  pending: z.boolean(),
  status: z.enum(['active', 'void']),
})

export const deletionSchema = z.object({
  entityType: z.enum([
    'account',
    'transaction',
    'balance_snapshot',
    'category',
    'category_rule',
    'transfer_match',
    'connection',
  ]),
  entityId: z.string(),
})

export const workingSetResponseSchema = z.object({
  /**
   * Replay from here next time. Deliberately re-sent with a small overlap rather than a strict `>`
   * (§7.3): the client upserts by id, so replaying a few seconds is idempotent, and it sidesteps
   * clock skew and same-timestamp ties without needing a monotonic sequence.
   */
  cursor: z.string(),

  /**
   * The client's cursor predates the tombstone retention floor, so the server cannot prove what was
   * deleted. It says so rather than returning a silently incomplete delta.
   */
  fullResyncRequired: z.boolean(),

  /** The earliest date this response covers. Older history is fetched on demand. */
  coverageFrom: isoDate,

  /**
   * Transaction ids in a confirmed transfer pair.
   *
   * Sent whole rather than as a delta: there are few of them, and a client holding a stale partial
   * set would count a card payment as income — the error the pairing exists to prevent.
   */
  confirmedTransferIds: z.array(z.string().uuid()),

  /**
   * Sent whole, like the transfer ids. There are a few dozen at most, and a client with a partial
   * set would show "Uncategorized" for transactions that are categorized.
   */
  categories: z.array(workingSetCategorySchema),

  accounts: z.array(workingSetAccountSchema),
  balances: z.array(workingSetBalanceSchema),
  transactions: z.array(workingSetTransactionSchema),
  deletions: z.array(deletionSchema),
})

export type WorkingSetCategory = z.infer<typeof workingSetCategorySchema>
export type WorkingSetAccount = z.infer<typeof workingSetAccountSchema>
export type WorkingSetBalance = z.infer<typeof workingSetBalanceSchema>
export type WorkingSetTransaction = z.infer<typeof workingSetTransactionSchema>
export type Deletion = z.infer<typeof deletionSchema>
export type WorkingSetResponse = z.infer<typeof workingSetResponseSchema>

/** Default history window (§7.2). Two years is what every range in the control can reach. */
export const DEFAULT_WINDOW_DAYS = 730

/**
 * Tombstone retention (§7.3). A cursor older than this cannot be served a delta, because the rows
 * proving what was deleted are gone.
 */
export const TOMBSTONE_RETENTION_DAYS = 90

/**
 * How far back the cursor is rewound when replaying.
 *
 * Covers the window between a row's `updated_at` being stamped and its transaction committing — in
 * that gap a row can be invisible to a query whose cursor is already past its timestamp, and without
 * the overlap that row would never be sent again.
 */
export const CURSOR_OVERLAP_SECONDS = 5
