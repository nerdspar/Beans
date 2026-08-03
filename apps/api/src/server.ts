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
import { householdRoutes } from './routes/households.js'
import type { Pool } from 'pg'

export type ServerDependencies = {
  config: Config
  db: Database
  pool: Pool
  keyProvider: KeyProvider
  keyCache: DataKeyCache
  mailer: Mailer
}

export async function buildServer({
  config,
  db,
  pool,
  keyProvider,
  keyCache,
  mailer,
}: ServerDependencies): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: loggerOptions(config.logLevel, config.isProduction),
    // Behind Nginx Proxy Manager, so the client IP and protocol arrive in forwarded headers.
    // Without this, rate limiting would see every request as coming from the proxy.
    trustProxy: true,
  })

  await fastify.register(cors, {
    origin: config.publicUrl,
    // Required for the session cookie to be sent cross-origin during development, where Vite
    // serves the frontend from a different port.
    credentials: true,
  })

  const auth = createAuth(config, db)
  await fastify.register(authRoutes, { auth })

  await fastify.register(householdRoutes, {
    auth,
    config,
    mailer,
    deps: { pool, keyProvider, keyCache },
  })

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

    // The sync worker arrives in milestone 3. Reported explicitly rather than omitted, so the
    // absence is visible rather than looking like everything is fine.
    checks['syncWorker'] = 'not_configured'

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

  return fastify
}
