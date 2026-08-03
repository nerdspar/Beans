import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import type { Config } from '../config.js'
import type { Database } from '../db/client.js'
import { authAccount, authSession, authUser, authVerification } from '../db/schema/auth.js'
import { hashPassword, verifyPassword } from './password.js'

/**
 * Better Auth, mounted at `/api/auth`.
 *
 * Sessions live in Postgres. Cookies are httpOnly, sameSite lax, and secure in production. CSRF
 * protection, origin validation and auth-endpoint rate limiting are built in — see the notes on
 * each option below for what we are and are not relying on.
 */

export type Auth = ReturnType<typeof createAuth>

export function createAuth(config: Config, db: Database) {
  return betterAuth({
    baseURL: config.publicUrl,
    secret: config.betterAuthSecret,

    database: drizzleAdapter(db, {
      provider: 'pg',
      /**
       * Explicit mapping rather than passing the schema barrel.
       *
       * The adapter resolves tables by `schema[modelName]`, and our exports are camelCase
       * (`authUser`) while the model names are snake_case (`auth_user`). Handing it the barrel
       * would silently resolve to `undefined` for every model.
       */
      schema: {
        auth_user: authUser,
        auth_session: authSession,
        auth_account: authAccount,
        auth_verification: authVerification,
      },
    }),

    /**
     * Prefixed to avoid colliding with our financial `accounts` table — Better Auth's `account`
     * means "OAuth provider link" (ARCHITECTURE.md §6.1).
     */
    user: { modelName: 'auth_user' },
    session: {
      modelName: 'auth_session',
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      /**
       * Caches the session in a signed cookie so an authenticated request does not hit the
       * database purely to resolve who is asking.
       */
      cookieCache: { enabled: true, maxAge: 300 },
    },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      autoSignIn: true,
      /**
       * Off by default because a self-hosted install may have no mail configured at all, and
       * requiring verification there would lock the operator out of their own app. Turned on by
       * deployments that do have mail.
       */
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },

    /**
     * Optional per deployment. When unconfigured this key is absent entirely, so the client can
     * ask what is available and hide the Google button rather than render one that 500s.
     */
    ...(config.google === null
      ? {}
      : {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
              // Required to reliably receive a refresh token.
              accessType: 'offline' as const,
              prompt: 'select_account' as const,
            },
          },
        }),

    trustedOrigins: [config.publicUrl],

    advanced: {
      // Secure cookies are automatic in production; forced here so a misread NODE_ENV cannot
      // silently downgrade them.
      useSecureCookies: config.isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
      },
    },

    /**
     * Built-in, and enabled in production only by default. The in-memory store is correct for
     * Beans because it runs as a single container; a multi-instance deployment would need
     * `storage: 'database'`, which also requires adding Better Auth's `rateLimit` table.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 300, max: 3 },
        '/forget-password': { window: 300, max: 3 },
      },
    },
  })
}
