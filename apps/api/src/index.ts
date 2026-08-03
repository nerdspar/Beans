import { loadConfig } from './config.js'
import { DataKeyCache } from './crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from './crypto/local-master-key-provider.js'
import { createDatabase, createPool } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { createMailer } from './mail/mailer.js'
import { buildServer } from './server.js'
import { createSyncWorker } from './worker/sync-worker.js'

/**
 * Startup.
 *
 * The order matters: configuration and the master key are validated **before** anything listens. A
 * container that boots without a readable master key and only discovers it on the first write is a
 * container that looks healthy while being unable to do its job.
 */
async function main(): Promise<void> {
  const config = loadConfig()

  // Loaded before anything listens, so a missing or malformed key fails the boot rather than the
  // first write.
  const keyProvider = await LocalMasterKeyProvider.fromFile(config.masterKeyFile)
  const keyCache = new DataKeyCache()
  const mailer = createMailer(config)

  const pool = createPool(config.databaseUrl)
  const db = createDatabase(pool)

  // Idempotent, and serialized across instances by an advisory lock.
  await runMigrations(pool)

  // Built first so the worker can log through it, but not listening yet.
  const server = await buildServer({
    config,
    db,
    pool,
    keyProvider,
    keyCache,
    mailer,
    syncWorkerRunning: true,
  })

  const worker = createSyncWorker({
    config,
    deps: { pool, keyProvider, keyCache },
    logger: server.log,
  })

  /**
   * A worker that fails to start is fatal.
   *
   * Serving without it would mean every request succeeding while balances silently stop updating —
   * the worst failure this app has, and the hardest to notice. Better to fail the boot loudly and
   * have the container restart.
   */
  await worker.start()

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down')
    try {
      // Stop accepting work before closing what it depends on.
      await server.close()
      await worker.stop()
      await pool.end()
      process.exit(0)
    } catch (error) {
      server.log.error({ err: error }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await server.listen({ port: config.port, host: '0.0.0.0' })
}

main().catch((error: unknown) => {
  // Config, master-key and worker failures land here, before a logger exists. Print the message
  // only — a stack trace at this point is noise, and the message is written to be actionable.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
