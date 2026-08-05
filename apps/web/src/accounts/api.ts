import type { AccountType } from '@beans/shared'

/** The account-management endpoints. Mirrors `apps/api/src/routes/accounts.ts`. */

export type ManagedAccount = {
  id: string
  connectionId: string | null
  institutionName: string | null
  name: string
  providerName: string | null
  mask: string | null
  type: AccountType
  taxTreatment: string
  /** Decimal string, signed as stored. Null when the account has never reported one. */
  balance: string | null
  isManual: boolean
  isClosed: boolean
  closedOn: string | null
  signInverted: boolean
  /** What deletion would take with it. */
  transactionCount: number
}

export type AccountPatch = {
  displayName?: string
  type?: AccountType
  taxTreatment?: string
  isClosed?: boolean
  /** Only read when closing. Defaults to today on the server, and clears when reopening. */
  closedOn?: string
  signInverted?: boolean
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export function listManagedAccounts(): Promise<ManagedAccount[]> {
  return send<{ accounts: ManagedAccount[] }>('/api/accounts').then((body) => body.accounts ?? [])
}

export function updateAccount(id: string, patch: AccountPatch): Promise<{ rebuilt: boolean }> {
  return send(`/api/accounts/${id}`, json('PATCH', patch))
}

export type ManualAccountInput = {
  name: string
  institutionName: string
  type: AccountType
  balance: string
  effectiveDate: string
  taxTreatment?: string
  /** Set when creating an account that no longer exists, so history ends on this date. */
  closedOn?: string
}

export function createManualAccount(input: ManualAccountInput): Promise<{ accountId: string }> {
  return send('/api/accounts', json('POST', input))
}

export function recordManualBalance(
  id: string,
  balance: string,
  effectiveDate: string,
): Promise<void> {
  return send(`/api/accounts/${id}/balance`, json('POST', { balance, effectiveDate }))
}

export function deleteAccount(id: string): Promise<{ transactionsDeleted: number }> {
  return send(`/api/accounts/${id}`, { method: 'DELETE' })
}

/**
 * One position, as the API returns it.
 *
 * Every amount is a decimal string, like everywhere else money crosses this boundary. `shares` is a
 * string too, but for a different reason: it is a quantity carried verbatim from the provider, not
 * an amount that was ever converted to cents.
 */
export type Holding = {
  providerHoldingId: string
  symbol: string | null
  description: string | null
  shares: string | null
  marketValue: string
  costBasis: string | null
  purchasePrice: string | null
  currency: string | null
}

export type HoldingsReading = {
  /** Null when this account has never reported positions — which is not the same as holding none. */
  asOfDate: string | null
  /** When a sync last looked, whatever it found. Null means it never has. */
  checkedAt: string | null
  holdings: Holding[]
  previousAsOfDate: string | null
  /** Keyed by `providerHoldingId`. Absent for a position that did not exist at that observation. */
  previousMarketValues: Record<string, string>
}

export function readHoldings(accountId: string): Promise<HoldingsReading> {
  return send<HoldingsReading>(`/api/accounts/${accountId}/holdings`)
}

export type HouseholdHolding = Holding & {
  accountId: string
  /** What it was worth at the previous observation. Null when the position did not exist then. */
  previousMarketValue: string | null
}

export type HouseholdHoldingsReading = {
  holdings: HouseholdHolding[]
  asOfDate: string | null
  /** Whether any investment account has ever been inspected for positions. */
  everChecked: boolean
}

/** Every investment account's latest positions, for the portfolio-wide breakdown. */
export function readHouseholdHoldings(): Promise<HouseholdHoldingsReading> {
  return send<HouseholdHoldingsReading>('/api/holdings')
}

export type HoldingAccountSlice = {
  accountId: string
  accountName: string
  institutionName: string | null
  shares: string | null
  marketValue: string
  previousMarketValue: string | null
}

export type HoldingDetail = {
  key: string
  symbol: string | null
  description: string | null
  /** The security's total across accounts, one point per observed date. */
  series: { date: string; value: string }[]
  accounts: HoldingAccountSlice[]
  asOfDate: string | null
  previousAsOfDate: string | null
}

/**
 * One security, everywhere it is held.
 *
 * `from` bounds how much history the server decrypts to answer — the symbol is encrypted, so every
 * row in the window has to be opened and matched in application code.
 */
export function readHoldingDetail(symbol: string, from: string): Promise<HoldingDetail> {
  const query = new URLSearchParams({ symbol, from })
  return send<HoldingDetail>(`/api/holdings/detail?${query.toString()}`)
}
