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
import { staticSiteRoutes } from './routes/static-site.js'
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
    // Behind Nginx Proxy Manager, so the client IP and protocol arrive in forwarded headers.
    // Without this, rate limiting would see every request as coming from the proxy.
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
  await fastify.register(connectionRoutes, { auth, deps: contextDeps })
  await fastify.register(accountRoutes, { auth, deps: contextDeps })
  await fastify.register(categoryRoutes, { auth, deps: contextDeps })
  await fastify.register(importRoutes, { auth, deps: contextDeps })
  await fastify.register(preferenceRoutes, { auth, pool })
  await fastify.register(workingSetRoutes, { auth, context: contextDeps })
  await fastify.register(transferRoutes, { auth, deps: contextDeps })

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
    })
  })

  /*
   * Last, deliberately. It installs the not-found handler that falls back to `index.html`, so every
   * real route must already be registered or a deep link would shadow it.
   */
  await fastify.register(staticSiteRoutes)

  return fastify
}
