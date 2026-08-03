import type { FastifyServerOptions } from 'fastify'

/**
 * Narrowed to exclude `undefined`.
 *
 * `FastifyServerOptions['logger']` is optional, so returning it directly makes the result
 * `T | undefined` — which under `exactOptionalPropertyTypes` fails to satisfy Fastify's own
 * option, and derails its constructor overload resolution into the HTTP/2 signature. The error
 * that produces names neither the logger nor the real cause.
 */
type LoggerOptions = NonNullable<FastifyServerOptions['logger']>

/**
 * Structured JSON logging with a redaction list.
 *
 * Amounts, names, tokens and keys must never reach the logs. This matters more here than in a
 * typical app: the whole encryption design assumes plaintext financial data exists only in memory
 * and in the browser. A log file full of decrypted balances would quietly become the least
 * protected copy of the most sensitive data — unencrypted, long-lived, and routinely shipped
 * somewhere else.
 *
 * **When you add a sensitive field, add it here in the same commit.** Redaction that lags behind
 * the schema is redaction that does not work.
 */

/**
 * Wildcards match one level, so `*.balance` covers `account.balance` but not
 * `household.account.balance`. The doubled entries below are deliberate coverage of both depths
 * rather than duplication.
 */
const REDACTED_PATHS = [
  // Credentials and secrets.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.tokenHash',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.secret',
  '*.apiKey',

  // The SimpleFIN access URL is a credential with basic auth embedded in it.
  '*.accessUrl',
  '*.access_url',
  'accessUrl',

  // Key material. DataKey redacts itself, but a raw Buffer reaching a log would not.
  '*.dek',
  '*.wrappedDek',
  '*.masterKey',

  // Connection strings carry the database password.
  '*.databaseUrl',
  '*.connectionString',
  'DATABASE_URL',

  // Money. Even a single balance in a log line defeats the point of encrypting the column.
  '*.amount',
  '*.balance',
  '*.currentBalance',
  '*.availableBalance',
  '*.matchAmountMin',
  '*.matchAmountMax',

  // Identifying strings.
  '*.displayName',
  '*.providerName',
  '*.description',
  '*.payee',
  '*.memo',
  '*.mask',
  '*.email',
] as const

export function loggerOptions(level: string, isProduction: boolean): LoggerOptions {
  return {
    level,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: '[redacted]',
    },
    // Pretty output is a development nicety; production stays machine-readable JSON.
    ...(isProduction ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
    serializers: {
      // Fastify's defaults log full URLs. Query strings should never carry sensitive data, but
      // trimming the path is cheap insurance against a mistake elsewhere leaking through logs.
      req(request: { method: string; url: string; id: string }) {
        return {
          id: request.id,
          method: request.method,
          path: request.url.split('?')[0],
        }
      },
    },
  }
}

export { REDACTED_PATHS }
