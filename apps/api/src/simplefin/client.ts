import { parseAccountsResponse, type SimplefinResponse } from './protocol.js'

/**
 * The SimpleFIN HTTP client.
 *
 * Every request here spends part of a hard 24-per-day budget, so nothing in this module retries on
 * its own. Retry policy lives in `sync/quota.ts`, where it can see the whole day's spend — a client
 * that retried locally would be invisible to that accounting and could drain the budget without
 * anything noticing.
 */

/**
 * The live host.
 *
 * `bridge.simplefin.org` 302-redirects here, and a strict HTTP client **drops the Authorization
 * header across that cross-origin redirect** — which presents as an authentication failure on a
 * perfectly good access URL. Calling the beta host directly avoids the whole problem. "Beta" is a
 * misnomer; this is production.
 */
export const SIMPLEFIN_HOST = 'beta-bridge.simplefin.org'

/**
 * The Bridge warns at 45 days even though its developer guide claims 90. Chunk at the number the
 * live API actually enforces.
 */
export const MAX_WINDOW_DAYS = 45

const DAY_MS = 24 * 60 * 60 * 1000

export class SimplefinError extends Error {
  // Typed as `string` rather than a literal so subclasses can narrow it to their own name.
  override readonly name: string = 'SimplefinError'
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

/** Thrown when a setup token has already been claimed — possibly by someone else. */
export class SetupTokenAlreadyClaimedError extends SimplefinError {
  override readonly name = 'SetupTokenAlreadyClaimedError'

  constructor() {
    super(
      'This setup token has already been used. Tokens are single-use — generate a fresh one. ' +
        'If you have not used this token yourself, treat it as compromised and revoke it.',
      403,
    )
  }
}

export type Fetcher = typeof globalThis.fetch

/**
 * Decodes a setup token into its claim URL.
 *
 * The token is base64 of a plain URL — no JSON, no JWT. The v1 spec renders example tokens wrapped
 * across lines, so whitespace is stripped before decoding and missing `=` padding is tolerated.
 */
export function decodeSetupToken(setupToken: string): string {
  const compact = setupToken.replace(/\s+/g, '')
  if (compact.length === 0) {
    throw new SimplefinError('The setup token is empty')
  }

  let decoded: string
  try {
    decoded = Buffer.from(compact, 'base64').toString('utf8')
  } catch {
    throw new SimplefinError('The setup token is not valid base64')
  }

  if (!/^https:\/\/\S+$/.test(decoded)) {
    throw new SimplefinError('The setup token did not decode to an https claim URL')
  }

  return decoded
}

/**
 * Claims a setup token, returning the long-lived access URL.
 *
 * **Single use.** The protocol requires a server to succeed at most once per token, so this must
 * never be retried blindly: a second attempt cannot succeed, and a 403 may mean somebody else
 * claimed it. The caller records the outcome before trying again with a fresh token.
 */
export async function claimSetupToken(setupToken: string, fetcher: Fetcher): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken)

  const response = await fetcher(claimUrl, {
    method: 'POST',
    // Explicit and required — some stacks reject a bodyless POST without it.
    headers: { 'Content-Length': '0' },
  })

  const body = (await response.text()).trim()

  if (response.status === 403 || body.startsWith('Forbidden')) {
    throw new SetupTokenAlreadyClaimedError()
  }

  if (!response.ok) {
    throw new SimplefinError(
      `Claiming the setup token failed with status ${response.status}`,
      response.status,
    )
  }

  // The response is plain text — the bare access URL, not JSON.
  if (!/^https:\/\/[^:]+:[^@]+@\S+$/.test(body)) {
    throw new SimplefinError('The claim response was not a valid access URL')
  }

  return body
}

type ParsedAccessUrl = {
  origin: string
  path: string
  authorization: string
}

/**
 * Splits credentials out of an access URL.
 *
 * They are sent as a Basic auth header rather than left inline, so they cannot leak into logs,
 * redirects, or error messages that quote the URL.
 */
export function parseAccessUrl(accessUrl: string): ParsedAccessUrl {
  let url: URL
  try {
    url = new URL(accessUrl)
  } catch {
    throw new SimplefinError('The stored access URL is not a valid URL')
  }

  if (url.username === '' || url.password === '') {
    throw new SimplefinError('The stored access URL has no embedded credentials')
  }

  const credentials = Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
    'utf8',
  ).toString('base64')

  return {
    origin: url.origin,
    path: url.pathname.replace(/\/+$/, ''),
    authorization: `Basic ${credentials}`,
  }
}

export type FetchAccountsOptions = {
  /** Inclusive. Omitted on the first ever sync to take whatever history is offered. */
  startDate?: Date
  endDate?: Date
  /** Pending transactions are **not** returned unless asked for. */
  includePending?: boolean
  /** Skips transactions entirely — a cheap balance refresh. */
  balancesOnly?: boolean
}

/**
 * Fetches one window of accounts and transactions. **Spends exactly one request.**
 */
export async function fetchAccounts(
  accessUrl: string,
  fetcher: Fetcher,
  options: FetchAccountsOptions = {},
): Promise<SimplefinResponse> {
  const { origin, path, authorization } = parseAccessUrl(accessUrl)

  const url = new URL(`${origin}${path}/accounts`)

  // Unix seconds, never ISO.
  if (options.startDate !== undefined) {
    url.searchParams.set('start-date', String(Math.floor(options.startDate.getTime() / 1000)))
  }
  if (options.endDate !== undefined) {
    url.searchParams.set('end-date', String(Math.floor(options.endDate.getTime() / 1000)))
  }
  if (options.includePending === true) {
    url.searchParams.set('pending', '1')
  }
  if (options.balancesOnly === true) {
    url.searchParams.set('balances-only', '1')
  }

  const response = await fetcher(url, {
    method: 'GET',
    headers: { Authorization: authorization, Accept: 'application/json' },
  })

  const text = await response.text()

  if (response.status === 402) {
    throw new SimplefinError(
      'The SimpleFIN Bridge subscription for this connection has lapsed.',
      402,
    )
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new SimplefinError(
      `The Bridge returned a non-JSON response with status ${response.status}`,
      response.status,
    )
  }

  // A 403 still returns a well-formed JSON body, so it is parsed rather than thrown on — the
  // errors array carries the reason, and the caller surfaces it.
  return parseAccountsResponse(body)
}

/**
 * Splits a date range into windows the Bridge will accept.
 *
 * Chunking matters more than it looks: a bug that leaves `start-date` unset or zero produces a
 * request spanning decades, which the Bridge chunks internally and which can burn an entire day's
 * budget in one sync. Ranges are bounded here so that cannot happen by accident.
 */
export function splitIntoWindows(
  start: Date,
  end: Date,
  maxDays = MAX_WINDOW_DAYS,
): Array<{ startDate: Date; endDate: Date }> {
  if (start.getTime() >= end.getTime()) {
    return []
  }

  const windows: Array<{ startDate: Date; endDate: Date }> = []
  const maxMs = maxDays * DAY_MS

  let cursor = start.getTime()
  while (cursor < end.getTime()) {
    const windowEnd = Math.min(cursor + maxMs, end.getTime())
    windows.push({ startDate: new Date(cursor), endDate: new Date(windowEnd) })
    cursor = windowEnd
  }

  return windows
}
