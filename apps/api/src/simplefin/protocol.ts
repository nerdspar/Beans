import { parseDecimalToCents } from '@beans/shared'

/**
 * Parsing SimpleFIN `/accounts` responses.
 *
 * **The Bridge serves protocol v1, not v2.** `GET /simplefin/info` advertises `{"versions":["1.0"]}`,
 * so responses carry a top-level `errors` array of **plain strings** and nest `org` inside each
 * account. The v2 shape — structured `errlist` objects and a top-level `connections` array — is a
 * draft the Bridge does not yet serve, despite its own developer guide telling you to request it.
 *
 * This parser reads **both**, preferring whichever is present, so the eventual v2 rollout is not a
 * breaking change.
 *
 * Field naming is inconsistent in the protocol itself and there is no rule to infer it from:
 * `available-balance`, `balance-date` and `sfin-url` use hyphens, while `transacted_at`,
 * `cost_basis` and `market_value` use underscores. They are simply memorized here.
 */

export type SimplefinOrg = {
  domain: string | null
  name: string | null
  url: string | null
}

export type SimplefinTransaction = {
  id: string
  /** Already converted to integer cents. Positive means money into the account. */
  amountCents: bigint
  description: string
  payee: string | null
  memo: string | null
  pending: boolean
  /**
   * The effective date, as a UTC calendar date.
   *
   * `posted` is **0 while a transaction is pending**, so `transacted_at` is the fallback. Some
   * institutions send `pending: true`, others only the zero `posted` — both are treated as pending.
   */
  date: Date
}

/**
 * One position inside an investment account.
 *
 * Optional in the protocol and genuinely absent from many institutions — a brokerage that reports a
 * balance may report no positions at all. Nothing downstream may treat an empty list as an error or
 * as a claim that the account holds nothing.
 *
 * `shares` stays a **string**, deliberately. It is a quantity rather than an amount, it is routinely
 * fractional, and there is no cents-equivalent unit to normalize it to — so it is carried verbatim
 * from the provider and never arithmetic'd into a total.
 */
export type SimplefinHolding = {
  /** The provider's stable id for the position. Falls back to the symbol when absent. */
  id: string
  symbol: string | null
  description: string | null
  shares: string | null
  marketValueCents: bigint
  costBasisCents: bigint | null
  purchasePriceCents: bigint | null
  currency: string | null
}

export type SimplefinAccount = {
  id: string
  name: string
  org: SimplefinOrg
  /** ISO 4217, or null. At least one institution omits it entirely. */
  currency: string | null
  /** Verbatim from the provider, in cents. **No sign normalization has happened yet.** */
  balanceCents: bigint
  /**
   * For credit cards this appears to carry available *credit* rather than available cash. Shown on
   * account detail, never charted, and never used in any total.
   */
  availableBalanceCents: bigint | null
  balanceDate: Date | null
  transactions: SimplefinTransaction[]
  /** Empty when the institution reports no positions, which is common and is not an error. */
  holdings: SimplefinHolding[]
}

export type SimplefinResponse = {
  accounts: SimplefinAccount[]
  /**
   * Provider errors, as human-readable strings.
   *
   * **A 200 with good data can also carry errors** describing partially-failed connections — an
   * account can return a stale balance with nothing but a string here to say so. These are
   * surfaced to the user rather than swallowed, which is also a required item on SimpleFIN's own
   * conformance checklist.
   */
  errors: string[]
}

export class SimplefinParseError extends Error {
  override readonly name = 'SimplefinParseError'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Unix **seconds**, never ISO. A stale v1 doc example shows an ISO string; ignore it. */
function asDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return new Date(value * 1000)
}

/**
 * Extracts the error list, tolerating both protocol versions.
 *
 * v1: `errors: ["Connection to Chase may need attention", ...]`
 * v2: `errlist: [{ code: "con.auth", msg: "...", account_id: "..." }, ...]`
 */
function parseErrors(root: Record<string, unknown>): string[] {
  const errors: string[] = []

  if (Array.isArray(root['errors'])) {
    for (const entry of root['errors']) {
      const text = asString(entry)
      if (text !== null) {
        errors.push(text)
      }
    }
  }

  if (Array.isArray(root['errlist'])) {
    for (const entry of root['errlist']) {
      const record = asRecord(entry)
      if (record === null) continue
      const message = asString(record['msg']) ?? asString(record['code'])
      if (message !== null) {
        errors.push(message)
      }
    }
  }

  return errors
}

/**
 * v1 nests `org` in each account. v2 hoists them into a top-level `connections` array keyed by
 * `conn_id`. Resolve whichever is available.
 */
function parseOrg(
  account: Record<string, unknown>,
  connections: Map<string, Record<string, unknown>>,
): SimplefinOrg {
  const inline = asRecord(account['org'])
  const connectionId = asString(account['conn_id'])
  const source = inline ?? (connectionId === null ? null : (connections.get(connectionId) ?? null))

  return {
    domain: source === null ? null : asString(source['domain']),
    name: source === null ? null : asString(source['name']),
    url: source === null ? null : asString(source['url']),
  }
}

function parseTransaction(raw: unknown): SimplefinTransaction | null {
  const record = asRecord(raw)
  if (record === null) return null

  const id = asString(record['id'])
  const amount = asString(record['amount'])
  if (id === null || amount === null) {
    // Both are required by the spec. A row missing either cannot be deduplicated or counted, so it
    // is dropped rather than guessed at.
    return null
  }

  const postedDate = asDate(record['posted'])
  const transactedDate = asDate(record['transacted_at'])

  // `posted` is 0 while pending, which asDate turns into null. Some institutions set the `pending`
  // flag, others only zero the timestamp — either signal counts.
  const pending = record['pending'] === true || postedDate === null

  const date = postedDate ?? transactedDate
  if (date === null) {
    return null
  }

  return {
    id,
    amountCents: parseDecimalToCents(amount),
    description: asString(record['description']) ?? '',
    // `payee` and `memo` are Bridge extensions, absent from both protocol versions.
    payee: asString(record['payee']),
    memo: asString(record['memo']),
    pending,
    date,
  }
}

function parseAccount(
  raw: unknown,
  connections: Map<string, Record<string, unknown>>,
): SimplefinAccount | null {
  const record = asRecord(raw)
  if (record === null) return null

  const id = asString(record['id'])
  const balance = asString(record['balance'])
  if (id === null || balance === null) {
    return null
  }

  const availableBalance = asString(record['available-balance'])
  const transactions: SimplefinTransaction[] = []

  if (Array.isArray(record['transactions'])) {
    for (const entry of record['transactions']) {
      const transaction = parseTransaction(entry)
      if (transaction !== null) {
        transactions.push(transaction)
      }
    }
  }

  const holdings: SimplefinHolding[] = []

  if (Array.isArray(record['holdings'])) {
    for (const entry of record['holdings']) {
      const holding = parseHolding(entry)
      if (holding !== null) {
        holdings.push(holding)
      }
    }
  }

  return {
    id,
    name: asString(record['name']) ?? '',
    org: parseOrg(record, connections),
    // At least one institution omits currency entirely, so this stays nullable rather than
    // defaulting to USD and quietly asserting something we were not told.
    currency: asString(record['currency']),
    balanceCents: parseDecimalToCents(balance),
    availableBalanceCents: availableBalance === null ? null : parseDecimalToCents(availableBalance),
    balanceDate: asDate(record['balance-date']),
    transactions,
    holdings,
  }
}

/**
 * One position, or null when it carries nothing worth storing.
 *
 * `market_value` is the only required field. A position with no value is not a position, and the
 * identity falls back to the symbol because at least one institution omits `id` — without a stable
 * key every sync would insert the same holding again rather than updating it.
 *
 * Lenient like `parseAccount`: one unparseable position must not discard the rest of a portfolio.
 */
function parseHolding(raw: unknown): SimplefinHolding | null {
  const record = asRecord(raw)
  if (record === null) return null

  const marketValue = asString(record['market_value'])
  if (marketValue === null) return null

  const symbol = asString(record['symbol'])
  const id = asString(record['id']) ?? symbol
  if (id === null) return null

  const costBasis = asString(record['cost_basis'])
  const purchasePrice = asString(record['purchase_price'])

  return {
    id,
    symbol,
    description: asString(record['description']),
    shares: asString(record['shares']),
    marketValueCents: parseDecimalToCents(marketValue),
    costBasisCents: costBasis === null ? null : parseDecimalToCents(costBasis),
    purchasePriceCents: purchasePrice === null ? null : parseDecimalToCents(purchasePrice),
    currency: asString(record['currency']),
  }
}

/**
 * Parses a `/accounts` response body.
 *
 * Deliberately lenient about individual accounts and transactions — a single malformed row must not
 * discard an otherwise good sync — but strict about the envelope, because a response that is not
 * even shaped like SimpleFIN means something else answered (a proxy error page, a login redirect),
 * and treating that as "no accounts" would look like every account vanished.
 */
export function parseAccountsResponse(body: unknown): SimplefinResponse {
  const root = asRecord(body)
  if (root === null) {
    throw new SimplefinParseError('Response body was not a JSON object')
  }

  if (!Array.isArray(root['accounts'])) {
    throw new SimplefinParseError('Response body has no accounts array')
  }

  const connections = new Map<string, Record<string, unknown>>()
  if (Array.isArray(root['connections'])) {
    for (const entry of root['connections']) {
      const record = asRecord(entry)
      const id = record === null ? null : asString(record['id'])
      if (record !== null && id !== null) {
        connections.set(id, record)
      }
    }
  }

  const accounts: SimplefinAccount[] = []
  for (const entry of root['accounts']) {
    const account = parseAccount(entry, connections)
    if (account !== null) {
      accounts.push(account)
    }
  }

  return { accounts, errors: parseErrors(root) }
}

/**
 * Detects a rate-limit complaint in the error strings.
 *
 * There is no `429` and no `X-RateLimit-*` headers — over-quota arrives as prose in the `errors`
 * array, alongside an otherwise successful 200. String matching is the only option available, so it
 * is at least kept in one place.
 */
export function isRateLimitError(errors: readonly string[]): boolean {
  return errors.some((error) => /too many requests|exceeds recommended range/i.test(error))
}

/**
 * Detects the "this connection needs attention" family, which is how a stale or broken institution
 * link is reported while the request itself succeeds.
 */
export function isConnectionAttentionError(error: string): boolean {
  return /may need attention|upgrading this connection/i.test(error)
}
