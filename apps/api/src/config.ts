import { z } from 'zod'

/**
 * Environment configuration, validated once at startup.
 *
 * Validation is strict and eager on purpose. A self-hosted install that boots with a missing
 * secret and only fails on the first password reset — hours later, for a user, not the operator —
 * is far worse than a container that refuses to start with a clear message.
 */

const NON_EMPTY = z.string().trim().min(1)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: NON_EMPTY,

  /**
   * Path to the master key file — a Docker secret. The key itself is never an environment
   * variable, so a process listing or a crash dump of the environment cannot expose it.
   */
  MASTER_KEY_FILE: NON_EMPTY,

  /**
   * The public origin. Not cosmetic: Google rejects OAuth redirect URIs on bare IPs and .local
   * names, and service workers require a secure context.
   */
  PUBLIC_URL: NON_EMPTY,

  /**
   * Extra origins allowed to call the auth endpoints, comma-separated.
   *
   * Empty in production, where one container serves the API and the built frontend from a single
   * origin and `PUBLIC_URL` is already it. **Development is the case this exists for**: the web app
   * runs on Vite's port and the API on its own, so every auth request arrives cross-origin and
   * Better Auth rejects it as `INVALID_ORIGIN`.
   *
   * Enumerated rather than wildcarded on purpose — this list is the CSRF boundary.
   */
  EXTRA_TRUSTED_ORIGINS: z.string().optional(),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters. Generate: openssl rand -hex 32'),

  /** Optional per deployment — see the refinement below. */
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),

  RESEND_API_KEY: z.string().trim().optional(),
  DEMO_EMAIL: z.string().trim().email().optional(),
  DEMO_PASSWORD: z.string().trim().min(12).optional(),
  SMTP_URL: z.string().trim().optional(),
  MAIL_FROM: z.string().trim().optional(),
})

export type MailTransport =
  | { kind: 'resend'; apiKey: string; from: string }
  | { kind: 'smtp'; url: string; from: string }
  | { kind: 'disabled' }

export type Config = {
  nodeEnv: 'development' | 'test' | 'production'
  isProduction: boolean
  port: number
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  databaseUrl: string
  masterKeyFile: string
  publicUrl: string
  /** Always includes `publicUrl`. Anything else comes from `EXTRA_TRUSTED_ORIGINS`. */
  trustedOrigins: string[]
  betterAuthSecret: string
  /** Null when unconfigured, which hides the Google button rather than showing a broken one. */
  google: { clientId: string; clientSecret: string } | null
  mail: MailTransport
  /**
   * A shared read-only-ish account anyone can sign into, for showing the app to somebody.
   *
   * **Null unless deliberately configured, and that is the guardrail.** A demo button is a session
   * handed to anyone who can reach the host, so it exists only where the operator has said it
   * should. Nothing about it is on by default.
   *
   * Tenant isolation does the heavy lifting — the demo household is a household like any other, so
   * RLS keeps it away from real data (§6). What isolation does *not* stop is a visitor using the
   * deployment's own resources, which is why the demo account is blocked from sending invites and
   * from claiming a SimpleFIN connection. See `isDemoUser`.
   */
  demo: { email: string; password: string } | null
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`Invalid environment configuration:\n${details}`)
  }

  const raw = parsed.data

  // Google is optional per deployment so a self-hoster need not create a Google Cloud project —
  // but half-configured is a boot failure, not a silent fallback. Half-configured OAuth fails at
  // the redirect, which reads to the user as "the app is broken".
  // Held in locals so the `isSet` type guard narrows them for the object literal below.
  const googleClientId = raw.GOOGLE_CLIENT_ID
  const googleClientSecret = raw.GOOGLE_CLIENT_SECRET

  if (isSet(googleClientId) !== isSet(googleClientSecret)) {
    throw new ConfigError(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or both left empty to ' +
        'disable Google sign-in.',
    )
  }

  return Object.freeze({
    nodeEnv: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    databaseUrl: raw.DATABASE_URL,
    masterKeyFile: raw.MASTER_KEY_FILE,
    publicUrl: raw.PUBLIC_URL.replace(/\/+$/, ''),
    trustedOrigins: [
      raw.PUBLIC_URL.replace(/\/+$/, ''),
      ...(raw.EXTRA_TRUSTED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter((origin) => origin.length > 0),
    ],
    betterAuthSecret: raw.BETTER_AUTH_SECRET,
    google:
      isSet(googleClientId) && isSet(googleClientSecret)
        ? { clientId: googleClientId, clientSecret: googleClientSecret }
        : null,
    mail: resolveMailTransport(raw),
    /*
     * Both or neither. A demo email with no password would produce a button that cannot sign in,
     * which is worse than no button — it looks like the deployment is broken rather than that the
     * feature is off.
     */
    demo:
      isSet(raw.DEMO_EMAIL) && isSet(raw.DEMO_PASSWORD)
        ? { email: raw.DEMO_EMAIL, password: raw.DEMO_PASSWORD }
        : null,
  })
}

/**
 * Whether an acting user is the shared demo account.
 *
 * Compared on email rather than id so it needs no lookup and survives the demo being re-seeded.
 *
 * Used to refuse the two things tenant isolation cannot: sending an invite, which would put the
 * deployment's own mail credentials and domain behind a stranger's message, and claiming a
 * SimpleFIN connection, which would attach a real institution to an account anyone can sign into.
 * Neither is about protecting data — RLS already does that — they are about the host's resources.
 */
export function isDemoUser(config: Config, email: string | null | undefined): boolean {
  if (config.demo === null || email === null || email === undefined) return false
  return email.toLowerCase() === config.demo.email.toLowerCase()
}

/**
 * Mail degrades gracefully because a self-hosted install may have no mail at all. Household
 * invites always work as copy-paste links, so onboarding never depends on this being configured.
 *
 * Resend wins when both are present, since configuring it is the more deliberate act.
 */
function resolveMailTransport(raw: z.infer<typeof schema>): MailTransport {
  const from = raw.MAIL_FROM

  if (isSet(raw.RESEND_API_KEY)) {
    if (!isSet(from)) {
      throw new ConfigError('MAIL_FROM is required when RESEND_API_KEY is set.')
    }
    return { kind: 'resend', apiKey: raw.RESEND_API_KEY, from }
  }

  if (isSet(raw.SMTP_URL)) {
    if (!isSet(from)) {
      throw new ConfigError('MAIL_FROM is required when SMTP_URL is set.')
    }
    return { kind: 'smtp', url: raw.SMTP_URL, from }
  }

  return { kind: 'disabled' }
}
