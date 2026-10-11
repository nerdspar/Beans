import cors from '@fastify/cors'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { createAuth } from './auth/auth.js'
import { authRoutes } from './auth/routes.js'
import type { Config } from './config.js'
import type { Database } from './db/client.js'
import type { DataKeyCache } from './crypto/data-key-cache.js'
import type { KeyProvider } from './crypto/key-provider.js'
import { loggerOptions } from './logging.js'
import type { Mailer } from './mail/mailer.js'
import { accountRoutes } from './routes/accounts.js'
import { categoryRoutes } from './routes/categories.js'
import { connectionRoutes } from './routes/connections.js'
import { householdRoutes } from './routes/households.js'
import { importRoutes, MAX_IMPORT_BYTES } from './routes/imports.js'
import { preferenceRoutes } from './routes/preferences.js'
import { exportRoutes } from './routes/export.js'
import { staticSiteRoutes } from './routes/static-site.js'
import { recurringRoutes } from './routes/recurring.js'
import { retirementRoutes } from './routes/retirement.js'
import { transferRoutes } from './routes/transfers.js'
import { workingSetRoutes } from './routes/working-set.js'
import type { Pool } from 'pg'

export type ServerDependencies = {
  config: Config
  db: Database
  pool: Pool
  keyProvider: KeyProvider
  keyCache: DataKeyCache
  mailer: Mailer
  /**
   * Whether the background sync worker started.
   *
   * Reported by `/health` and treated as **unhealthy** when false: a stopped worker means balances
   * quietly stop updating while every request still succeeds, which is precisely the failure that
   * must not show a green light.
   */
  syncWorkerRunning: boolean
}

export async function buildServer({
  config,
  db,
  pool,
  keyProvider,
  keyCache,
  mailer,
  syncWorkerRunning,
}: ServerDependencies): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: loggerOptions(config.logLevel, config.isProduction),
    /*
     * Always behind something — a Cloudflare tunnel, or a reverse proxy — so the scheme the user
     * actually used arrives in a forwarded header. Without this, `request.protocol` reads `http`
     * on every request and anything deriving a URL from it emits links that downgrade.
     *
     * It does **not** decide the client IP for rate limiting. `trustProxy: true` takes the leftmost
     * forwarded entry, which the client controls; the limiter reads the single header the operator
     * named in `TRUSTED_IP_HEADER` instead. The reason to keep `true` here anyway is that nothing
     * security-bearing reads `request.ip` — it reaches the logs and stops there.
     */
    trustProxy: true,

    /*
     * Large enough that the import route's own limit is the one that fires.
     *
     * Fastify defaults to 1 MiB, which is well under the 10 MB the import route accepts — so a real
     * multi-year export was rejected by the framework with a bare "Payload Too Large" before any
     * route ran, and the route's limit was decoration. The two limits have to agree about which one
     * is authoritative, and it should be the one that can explain itself.
     *
     * The margin covers JSON string escaping: the CSV is sent as a JSON string field, and quotes,
     * backslashes and newlines each cost an extra byte on the wire.
     */
    bodyLimit: MAX_IMPORT_BYTES + 2 * 1024 * 1024,
  })

  await fastify.register(cors, {
    origin: config.publicUrl,
    // Required for the session cookie to be sent cross-origin during development, where Vite
    // serves the frontend from a different port.
    credentials: true,
  })

  const auth = createAuth(config, db)
  await fastify.register(authRoutes, { auth })

  const contextDeps = { pool, keyProvider, keyCache }

  await fastify.register(householdRoutes, { auth, config, mailer, deps: contextDeps })
  await fastify.register(connectionRoutes, { auth, config, deps: contextDeps })
  await fastify.register(accountRoutes, { auth, deps: contextDeps })
  await fastify.register(categoryRoutes, { auth, deps: contextDeps })
  await fastify.register(importRoutes, { auth, deps: contextDeps })
  await fastify.register(preferenceRoutes, { auth, pool })
  await fastify.register(workingSetRoutes, { auth, context: contextDeps })
  await fastify.register(transferRoutes, { auth, deps: contextDeps })
  await fastify.register(recurringRoutes, { auth, deps: contextDeps })
  await fastify.register(retirementRoutes, { auth, deps: contextDeps })
  await fastify.register(exportRoutes, { auth, deps: contextDeps })

  /**
   * Reports what the container can actually do, not merely that the process is alive.
   *
   * A health check that only proves Node is running is worse than none — it turns a database
   * outage into a silently degraded service that every orchestrator considers healthy.
   */
  fastify.get('/health', async (_request, reply) => {
    const checks: Record<string, string> = {}
    let healthy = true

    try {
      await pool.query('select 1')
      checks['database'] = 'ok'
    } catch (error) {
      checks['database'] = 'unreachable'
      healthy = false
      fastify.log.error({ err: error }, 'health check: database unreachable')
    }

    checks['syncWorker'] = syncWorkerRunning ? 'running' : 'stopped'
    if (!syncWorkerRunning) {
      // A stopped worker means balances silently stop updating while every request still succeeds —
      // exactly the failure that must not read as healthy.
      healthy = false
    }

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      checks,
    })
  })

  /**
   * What the client needs to render the sign-in screen correctly, before anyone is signed in.
   *
   * Google is optional per deployment, so the frontend asks rather than assuming — showing a
   * Google button on an install with no Google credentials produces a broken redirect, which
   * reads to a user as "this app doesn't work".
   */
  fastify.get('/api/capabilities', async (_request, reply) => {
    return reply.send({
      googleSignIn: config.google !== null,
      emailDelivery: config.mail.kind !== 'disabled',
      /*
       * Absent unless the operator configured it. A demo button is a session handed to anyone who
       * can reach the host, so it is opt-in per deployment rather than something Beans ships on.
       */
      demoSignIn: config.demo !== null,
    })
  })

  /**
   * Signs in as the shared demo account.
   *
   * The password stays on the server. Putting demo credentials in the client bundle would publish
   * them to anyone who reads the JavaScript — harmless for this account and a bad habit to build
   * into the shape of the app.
   *
   * A plain 404 when unconfigured, matching a route that does not exist, because it does not.
   */
  fastify.post('/api/demo/sign-in', async (request, reply) => {
    if (config.demo === null) {
      return reply.status(404).send({ error: 'Not found' })
    }

    try {
      const response = await auth.api.signInEmail({
        body: { email: config.demo.email, password: config.demo.password },
        asResponse: true,
      })

      // Better Auth sets the session cookie on its own response; this forwards it verbatim.
      for (const [name, value] of response.headers.entries()) {
        if (name.toLowerCase() === 'set-cookie') reply.header('set-cookie', value)
      }

      return reply.status(response.status).send(await response.json().catch(() => ({})))
    } catch {
      /*
       * Almost always "the demo account has not been seeded yet". Said plainly, because the person
       * seeing it is the operator who can run the seeder.
       */
      return reply.status(503).send({
        error: 'The demo account is configured but has not been created yet. Run pnpm demo:seed.',
      })
    }
  })

  /*
   * What this process actually resolved, said once at boot.
   *
   * Written because a deployment reported `emailDelivery: true` from this endpoint while invites
   * from the same host reported no mail transport — which can only happen if the two requests were
   * answered by different processes. Nothing in the logs could confirm or refute that, because a
   * disabled mailer does no work and therefore leaves no trace.
   *
   * The transport *kind* only. Never the API key, the from address, or the database URL — this line
   * exists to identify a process, not to dump its configuration.
   */
  fastify.log.info(
    {
      mailTransport: config.mail.kind,
      googleSignIn: config.google !== null,
      publicUrl: config.publicUrl,
    },
    'server capabilities resolved',
  )

  /*
   * Last, deliberately. It installs the not-found handler that falls back to `index.html`, so every
   * real route must already be registered or a deep link would shadow it.
   */
  await fastify.register(staticSiteRoutes)

  return fastify
}
