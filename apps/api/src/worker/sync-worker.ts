import { PgBoss } from 'pg-boss'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../config.js'
import {
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import { jitterForSchedule, SCHEDULED_SYNCS_PER_DAY } from '../sync/quota.js'
import { markStaleConnections, runSync } from '../sync/sync-service.js'

/**
 * Background sync, on pg-boss.
 *
 * Durable scheduling on the Postgres we already run, rather than adding Redis for the sake of four
 * jobs a day.
 *
 * **pg-boss gets its own connection pool, never the application's.** Our RLS design sets
 * `app.current_household` as session state on connections; sharing a pool would leak that state
 * into pg-boss's own queries against its schema. The pool is small because the workload is tiny.
 *
 * Note for anyone updating this: pg-boss v12 has **no default export** (`import { PgBoss }`),
 * queues must be created explicitly before sending, and handlers always receive an **array** even
 * at a batch size of one. All three changed recently and most examples online are wrong.
 */

const SYNC_QUEUE = 'sync-connection'
const SCHEDULE_QUEUE = 'sync-schedule-tick'

/** Spread within the hour, so every household does not hit the Bridge on the same tick. */
const JITTER_WINDOW_MS = 55 * 60 * 1000

export type SyncJobData = {
  householdId: string
  userId: string
  connectionId: string
}

export type SyncWorkerDependencies = {
  config: Config
  deps: ContextDependencies
  logger: FastifyBaseLogger
  fetcher?: typeof globalThis.fetch
}

export type SyncWorker = {
  start(): Promise<void>
  stop(): Promise<void>
  /** Enqueues a sync now, for a manual refresh. Budget is still enforced inside the handler. */
  enqueue(data: SyncJobData): Promise<void>
}

export function createSyncWorker({
  config,
  deps,
  logger,
  fetcher = globalThis.fetch,
}: SyncWorkerDependencies): SyncWorker {
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    // Deliberately separate from the application pool. See the note above.
    max: 3,
  })

  boss.on('error', (error: unknown) => {
    logger.error({ err: error }, 'pg-boss error')
  })

  async function handleSync(data: SyncJobData): Promise<void> {
    try {
      const attempt = await withHouseholdContext(deps, data.userId, async (context) =>
        runSync(context, data.connectionId, fetcher, 'scheduled'),
      )

      if (!attempt.ran) {
        // Expected, not exceptional — a connection backing off or out of budget. Logged at debug so
        // it does not drown the failures that matter.
        logger.debug({ connectionId: data.connectionId, reason: attempt.reason }, 'sync skipped')
        return
      }

      if (!attempt.ok) {
        // Already recorded on the sync run and reflected in the connection's failure count, so this
        // is purely operator visibility. Not rethrown: pg-boss would retry outside the request
        // budget, which is the one thing the budget exists to prevent.
        logger.error({ connectionId: data.connectionId, error: attempt.error }, 'sync failed')
        return
      }

      logger.info(
        {
          connectionId: data.connectionId,
          accountsUpdated: attempt.outcome.accountsUpdated,
          transactionsUpserted: attempt.outcome.transactionsUpserted,
          transactionsVoided: attempt.outcome.transactionsVoided,
          requestsSpent: attempt.outcome.requestsSpent,
          providerErrors: attempt.outcome.errors.length,
        },
        'sync completed',
      )
    } catch (error) {
      // Reaching here means the household context itself failed — a missing membership, or the
      // database being unreachable — rather than the sync. Nothing was spent.
      logger.error({ err: error, connectionId: data.connectionId }, 'sync could not start')
    }
  }

  /**
   * Fans out a sync job per connection.
   *
   * Runs on a cron tick, then delays each connection by a **stable** per-connection offset. The
   * offset is derived from the connection id rather than randomly, so a connection lands at roughly
   * the same time each day instead of wandering, while still spreading load across the hour.
   *
   * `schedule()` cannot express this directly: its options are serialized once and replayed
   * verbatim on every fire, so a random `startAfter` there would be a fixed constant.
   */
  async function handleScheduleTick(): Promise<void> {
    const connections = await listSyncableConnections(deps)

    for (const connection of connections) {
      await boss.send(SYNC_QUEUE, connection, {
        startAfter: Math.floor(jitterForSchedule(connection.connectionId, JITTER_WINDOW_MS) / 1000),
      })
    }

    logger.info({ connections: connections.length }, 'sync schedule tick')
  }

  return {
    async start(): Promise<void> {
      await boss.start()

      // Queues must exist before anything is sent to them; sending to an unknown queue throws.
      await boss.createQueue(SYNC_QUEUE, {
        // Retries are opt-out in pg-boss and would double-spend our request budget, so they are
        // off: `runSync` already applies its own backoff, which is budget-aware.
        retryLimit: 0,
        expireInSeconds: 15 * 60,
      })
      await boss.createQueue(SCHEDULE_QUEUE, { retryLimit: 0 })

      // Handlers receive an array even at batch size 1.
      await boss.work<SyncJobData>(SYNC_QUEUE, async (jobs) => {
        for (const job of jobs) {
          await handleSync(job.data)
        }
      })

      await boss.work(SCHEDULE_QUEUE, async () => {
        await handleScheduleTick()
      })

      // Five-field cron. A six-field expression misfires here, because schedules are only evaluated
      // every 30 seconds.
      const hours = scheduleHours(SCHEDULED_SYNCS_PER_DAY)
      await boss.schedule(SCHEDULE_QUEUE, `0 ${hours} * * *`, null, { tz: 'UTC' })

      logger.info({ hours }, 'sync worker started')
    },

    async stop(): Promise<void> {
      await boss.stop({ graceful: true })
    },

    async enqueue(data: SyncJobData): Promise<void> {
      await boss.send(SYNC_QUEUE, data)
    },
  }
}

/** Evenly spaced hours, offset off midnight to avoid the top-of-day traffic peak. */
function scheduleHours(perDay: number): string {
  const step = Math.max(1, Math.floor(24 / perDay))
  const hours: number[] = []
  for (let hour = 2; hour < 24; hour += step) {
    hours.push(hour)
  }
  return hours.join(',')
}

/**
 * Every connection due for a scheduled sync, across all households.
 *
 * The scheduler has no user, but every financial table is behind RLS with FORCE — so a direct
 * `select ... from connections` here returns **zero rows**, silently, and the scheduler would sync
 * nothing forever while looking perfectly healthy.
 *
 * Rather than granting the worker a `BYPASSRLS` role — which would put a second, unscoped path to
 * every household's data into the codebase purely for scheduling convenience — it enumerates users
 * from `auth_user` (identity is cross-household by design and carries no RLS) and then enters each
 * household properly. The scheduler therefore has no more access than an ordinary request; it just
 * makes one per tenant.
 */
async function listSyncableConnections(deps: ContextDependencies): Promise<SyncJobData[]> {
  const users = await deps.pool.query<{ id: string }>('select id from auth_user')

  const jobs = new Map<string, SyncJobData>()

  for (const user of users.rows) {
    try {
      const connections = await withHouseholdContext(deps, user.id, async (context) => {
        const result = await context.client.query<{ id: string }>(
          `select c.id
             from connections c
            where exists (
              select 1 from accounts a
               where a.connection_id = c.id and a.confirmed_at is not null
            )`,
        )
        return result.rows.map((row) => ({
          householdId: context.householdId,
          userId: user.id,
          connectionId: row.id,
        }))
      })

      // Household members share connections, so the same one surfaces once per member. Keyed by
      // connection id so it is synced once, not once per person.
      for (const job of connections) {
        if (!jobs.has(job.connectionId)) {
          jobs.set(job.connectionId, job)
        }
      }
    } catch {
      // A user with no household has nothing to sync. Expected for anyone mid-signup.
      continue
    }
  }

  return [...jobs.values()]
}
