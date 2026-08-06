import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { AccountType, IsoDate } from '@beans/shared'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from '../repositories/household-context.js'
import { createManualAccount, recordManualBalance } from '../repositories/accounts.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import { ensureCoverageStart, rebuildAccountHistory, rebuildHouseholdHistory } from './rebuild.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')
const USER = 'rebuild-user-fixed-id'

const TODAY: IsoDate = '2026-08-03'
const AS_OF = new Date('2026-08-03T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('balance history rebuild', () => {
  let pool: Pool
  let deps: ContextDependencies

  /** Creates a confirmed account with an observed balance. */
  async function makeAccount(
    context: HouseholdContext,
    options: {
      type: AccountType
      balanceCents: bigint
      coverageStart?: IsoDate | null
      isManual?: boolean
      balanceAsOf?: Date
      closedOn?: IsoDate
    },
  ): Promise<string> {
    const result = await context.client.query<{ id: string }>(
      `insert into accounts (
         household_id, type, currency, current_balance, balance_as_of,
         coverage_start_date, is_manual, confirmed_at, is_closed, closed_on
       ) values ($1,$2,'USD',$3,$4,$5,$6,$4,$7::date is not null,$7::date) returning id`,
      [
        context.householdId,
        options.type,
        context.cipher.encryptMoney(options.balanceCents),
        options.balanceAsOf ?? AS_OF,
        options.coverageStart === undefined ? '2026-07-31' : options.coverageStart,
        options.isManual ?? false,
        options.closedOn ?? null,
      ],
    )
    return result.rows[0]!.id
  }

  async function addTransaction(
    context: HouseholdContext,
    accountId: string,
    date: IsoDate,
    amountCents: bigint,
    status: 'active' | 'void' = 'active',
  ): Promise<void> {
    await context.client.query(
      `insert into transactions (household_id, account_id, posted_date, amount, description, status, source)
       values ($1,$2,$3,$4,$5,$6,'synced')`,
      [
        context.householdId,
        accountId,
        date,
        context.cipher.encryptMoney(amountCents),
        context.cipher.encryptText('test'),
        status,
      ],
    )
  }

  async function readSeries(
    context: HouseholdContext,
    accountId: string,
  ): Promise<Array<{ date: IsoDate; balance: bigint; source: string }>> {
    const rows = await context.client.query<{
      as_of_date: IsoDate
      balance: Buffer
      source: string
    }>(
      'select as_of_date, balance, source from balance_snapshots where account_id = $1 order by as_of_date',
      [accountId],
    )
    return rows.rows.map((row) => ({
      date: row.as_of_date,
      balance: context.cipher.decryptMoney(row.balance),
      source: row.source,
    }))
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({
        currentVersion: 1,
        keys: { 1: MASTER_KEY },
      }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
    await resetAll(pool)
    await pool.query(
      'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
      [USER, 'Test User', 'rebuild@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER])
    await createHousehold(deps, USER, 'The Goldbergs')
  })

  describe('derived accounts', () => {
    it('writes a series that ends exactly at the observed balance', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        await addTransaction(ctx, accountId, '2026-08-02', -5_000n)
        await addTransaction(ctx, accountId, '2026-08-01', 20_000n)

        const result = await rebuildAccountHistory(ctx, accountId, TODAY)
        expect(result.consistent).toBe(true)

        return readSeries(ctx, accountId)
      })

      expect(series).toEqual([
        { date: '2026-07-31', balance: 85_000n, source: 'derived' },
        { date: '2026-08-01', balance: 105_000n, source: 'derived' },
        { date: '2026-08-02', balance: 100_000n, source: 'derived' },
        { date: '2026-08-03', balance: 100_000n, source: 'derived' },
      ])
    })

    it('excludes voided transactions', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        // A pending transaction that vanished without posting never happened; counting it would
        // drift the whole series before its date.
        await addTransaction(ctx, accountId, '2026-08-01', -50_000n, 'void')

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series.every((entry) => entry.balance === 100_000n)).toBe(true)
    })

    it('rewrites the series when a late transaction posts', async () => {
      const after = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        await rebuildAccountHistory(ctx, accountId, TODAY)

        // A −$50 transaction dated 8/1 posts late; the balance drops accordingly.
        await addTransaction(ctx, accountId, '2026-08-01', -5_000n)
        await ctx.client.query('update accounts set current_balance = $1 where id = $2', [
          ctx.cipher.encryptMoney(95_000n),
          accountId,
        ])

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      // Dates before the late transaction are unchanged; from its date forward, shifted.
      expect(after).toEqual([
        { date: '2026-07-31', balance: 100_000n, source: 'derived' },
        { date: '2026-08-01', balance: 95_000n, source: 'derived' },
        { date: '2026-08-02', balance: 95_000n, source: 'derived' },
        { date: '2026-08-03', balance: 95_000n, source: 'derived' },
      ])
    })

    /**
     * `checkReconstruction` cannot detect a sign convention error, and this records why rather
     * than pretending otherwise.
     *
     * The series is reconstructed *from* the current balance, and `reconstructBackward` explicitly
     * preserves "the invariant that the last entry equals the observed balance exactly". So the
     * check compares a value to the thing it was derived from: it can only fail if reconstruction
     * itself is buggy, which is worth knowing but is not the failure it was written for.
     *
     * This test used to be called "reports inconsistency when the series cannot reconcile" while
     * asserting the opposite, which made it read as coverage for a detector that does not exist.
     * The real one lives in `analyseDrift`, and works from two independent observations — the thing
     * reconstruction cannot supply.
     */
    it('reconciles by construction, so it cannot see a sign convention error', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        await addTransaction(ctx, accountId, '2026-08-01', -5_000n)

        await rebuildAccountHistory(ctx, accountId, TODAY)

        // The balance moves without any transaction explaining it — the shape of the failure.
        await ctx.client.query('update accounts set current_balance = $1 where id = $2', [
          ctx.cipher.encryptMoney(90_000n),
          accountId,
        ])

        return rebuildAccountHistory(ctx, accountId, TODAY)
      })

      // Consistent, because the series was rebuilt from the new balance. Documented, not desired.
      expect(result.consistent).toBe(true)
    })

    it('carries a stale balance forward rather than leaving a hole', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 54_770n,
          coverageStart: '2026-07-30',
          balanceAsOf: new Date('2026-07-31T12:00:00.000Z'),
        })

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      // Through 7/31 derived; 8/1 onward carried, and labelled as such.
      expect(series.map((e) => e.source)).toEqual([
        'derived',
        'derived',
        'carried',
        'carried',
        'carried',
      ])
      expect(series.every((e) => e.balance === 54_770n)).toBe(true)
      expect(series.at(-1)?.date).toBe(TODAY)
    })

    it('reconstructs a liability with negative balances throughout', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'mortgage',
          balanceCents: -82_487_123n,
          coverageStart: '2026-08-01',
        })
        await addTransaction(ctx, accountId, '2026-08-02', 328_956n)

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series.at(-1)?.balance).toBe(-82_487_123n)
      expect(series[0]?.balance).toBe(-82_816_079n)
      expect(series.every((e) => e.balance < 0n)).toBe(true)
    })
  })

  describe('investment accounts', () => {
    /**
     * Backward reconstruction is mathematically wrong here: their value moves with the market, not
     * with transactions.
     */
    it('uses forward observations, ignoring transactions', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'investment',
          balanceCents: 104_202_386n,
          coverageStart: '2026-08-01',
        })
        // A dividend. It must not move the historical series backward.
        await addTransaction(ctx, accountId, '2026-08-02', 50_000n)

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series.every((e) => e.source === 'observed')).toBe(true)
      // Flat at the observed value rather than reconstructed backward through the dividend.
      expect(series.every((e) => e.balance === 104_202_386n)).toBe(true)
    })

    it('builds a step series from accumulated daily observations', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'investment',
          balanceCents: 104_202_386n,
          coverageStart: '2026-08-01',
        })

        // Yesterday's observation, as the daily job would have recorded it.
        await ctx.client.query(
          `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
           values ($1,$2,'2026-08-01',$3,'observed')`,
          [ctx.householdId, accountId, ctx.cipher.encryptMoney(100_000_000n)],
        )

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series).toEqual([
        { date: '2026-08-01', balance: 100_000_000n, source: 'observed' },
        { date: '2026-08-02', balance: 100_000_000n, source: 'observed' },
        { date: '2026-08-03', balance: 104_202_386n, source: 'observed' },
      ])
    })
  })

  describe('manual accounts', () => {
    it('holds each entered balance flat until the next', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'other_asset',
          balanceCents: 115_780_000n,
          coverageStart: '2026-08-01',
          isManual: true,
        })

        for (const [date, cents] of [
          ['2026-08-01', 115_000_000n],
          ['2026-08-03', 115_780_000n],
        ] as const) {
          await ctx.client.query(
            `insert into manual_balance_updates (household_id, account_id, effective_date, balance)
             values ($1,$2,$3,$4)`,
            [ctx.householdId, accountId, date, ctx.cipher.encryptMoney(cents)],
          )
        }

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series).toEqual([
        { date: '2026-08-01', balance: 115_000_000n, source: 'observed' },
        { date: '2026-08-02', balance: 115_000_000n, source: 'observed' },
        { date: '2026-08-03', balance: 115_780_000n, source: 'observed' },
      ])
    })

    /**
     * Backdating a valuation has to move the coverage boundary, or the entry is invisible.
     *
     * The series is built from `coverage_start_date` forward, and the update that moved it sat
     * behind the "only if this is the newest entry" guard that protects the headline balance. So
     * recording what a house was worth last year wrote its row and changed nothing on the chart —
     * the only way to give a manual asset earlier history silently did nothing.
     */
    it('extends coverage backwards when an earlier valuation is recorded', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        // Entered today, the way the form defaults: one point, and no history behind it.
        const { accountId } = await createManualAccount(ctx, {
          name: 'The house',
          institutionName: 'Manual',
          type: 'other_asset',
          balanceCents: 115_780_000n,
          effectiveDate: TODAY,
        })

        // Then what it was worth two days ago.
        await recordManualBalance(ctx, accountId, '2026-08-01', 115_000_000n, TODAY)

        return readSeries(ctx, accountId)
      })

      /*
       * Asserted by date rather than as a whole list. `createManualAccount` stamps `balance_as_of`
       * with SQL `now()`, so the series runs to the real clock and its length is not a fixture —
       * the fix is about where it starts, which is.
       */
      expect(series[0]).toEqual({ date: '2026-08-01', balance: 115_000_000n, source: 'observed' })
      // Held flat until the later valuation, rather than interpolated toward it.
      expect(series.find((row) => row.date === '2026-08-02')?.balance).toBe(115_000_000n)
      expect(series.find((row) => row.date === TODAY)?.balance).toBe(115_780_000n)
    })

    /** The guard the fix had to preserve: an old valuation is not what the house is worth now. */
    it('does not let a backdated valuation become the current balance', async () => {
      const current = await withHouseholdContext(deps, USER, async (ctx) => {
        const { accountId } = await createManualAccount(ctx, {
          name: 'The house',
          institutionName: 'Manual',
          type: 'other_asset',
          balanceCents: 115_780_000n,
          effectiveDate: TODAY,
        })

        await recordManualBalance(ctx, accountId, '2026-08-01', 115_000_000n, TODAY)

        const row = await ctx.client.query<{ current_balance: Buffer }>(
          'select current_balance from accounts where id = $1',
          [accountId],
        )
        return ctx.cipher.decryptMoney(row.rows[0]!.current_balance)
      })

      expect(current).toBe(115_780_000n)
    })
  })

  describe('the import seam', () => {
    /**
     * The spec's explicit requirement: imported plus synced history must produce one continuous
     * series with no double counting and no gap at the cutover.
     */
    it('joins imported and derived history with no gap and no duplicate', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 100_000n,
          coverageStart: '2026-07-28',
        })

        await ctx.client.query('update accounts set import_cutover_date = $1 where id = $2', [
          '2026-08-01',
          accountId,
        ])

        for (const [date, cents] of [
          ['2026-07-28', 70_000n],
          ['2026-07-29', 75_000n],
          ['2026-07-30', 80_000n],
          ['2026-07-31', 85_000n],
          // Deliberately overlaps the cutover, which synced data must win.
          ['2026-08-01', 1n],
        ] as const) {
          await ctx.client.query(
            `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
             values ($1,$2,$3,$4,'imported')`,
            [ctx.householdId, accountId, date, ctx.cipher.encryptMoney(cents)],
          )
        }

        await addTransaction(ctx, accountId, '2026-08-02', -5_000n)

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series.map((e) => e.date)).toEqual([
        '2026-07-28',
        '2026-07-29',
        '2026-07-30',
        '2026-07-31',
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
      ])

      // One entry per day — a duplicated seam day would double-count in every household total.
      expect(new Set(series.map((e) => e.date)).size).toBe(series.length)

      // Synced data owns the cutover day; the imported placeholder of 1 cent is gone.
      expect(series[4]).toEqual({ date: '2026-08-01', balance: 105_000n, source: 'derived' })
      expect(series.slice(0, 4).every((e) => e.source === 'imported')).toBe(true)
      expect(series.at(-1)?.balance).toBe(100_000n)
    })
  })

  describe('coverage boundary', () => {
    it('produces nothing until coverage is established', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 100_000n,
          coverageStart: null,
        })
        return rebuildAccountHistory(ctx, accountId, TODAY)
      })

      // Drawing a line without knowing how far back we can trust it is worse than drawing none.
      expect(result.snapshotsWritten).toBe(0)
      expect(result.coverageStart).toBeNull()
    })

    it('sets the boundary once and never moves it', async () => {
      const coverage = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 100_000n,
          coverageStart: null,
        })

        await ensureCoverageStart(ctx, accountId, '2026-07-01')
        // A later, narrower window must not widen the claim.
        await ensureCoverageStart(ctx, accountId, '2026-01-01')

        const rows = await ctx.client.query<{ coverage_start_date: IsoDate }>(
          'select coverage_start_date from accounts where id = $1',
          [accountId],
        )
        return rows.rows[0]?.coverage_start_date
      })

      expect(coverage).toBe('2026-07-01')
    })

    it('never writes a snapshot before the boundary', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 100_000n,
          coverageStart: '2026-08-02',
        })
        // A transaction from before coverage. Reconstruction must not extend backward to reach it.
        await addTransaction(ctx, accountId, '2026-07-01', 999_999n)

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series[0]?.date).toBe('2026-08-02')
    })
  })

  /**
   * A closed account is not gone, it ended.
   *
   * Both obvious treatments are wrong. Carrying its last balance forward leaves a dead account in
   * net worth forever; dropping it erases money the household really did have and lowers every
   * historical point. The series has to stop at the close date and contribute zero after it.
   */
  describe('closed accounts', () => {
    it('keeps history up to the close date and nothing after', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 50_000n,
          coverageStart: '2026-07-31',
          closedOn: '2026-08-01',
        })

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return await readSeries(ctx, accountId)
      })

      // Through the close date, then a single zero the day after — and nothing beyond it.
      expect(series.map((row) => row.date)).toEqual(['2026-07-31', '2026-08-01', '2026-08-02'])
      expect(series.at(-1)?.balance).toBe(0n)
    })

    it('does not carry a closed balance forward to today', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 50_000n,
          coverageStart: '2026-07-31',
          closedOn: '2026-08-01',
        })

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return await readSeries(ctx, accountId)
      })

      // The bug this prevents: $500 sitting in net worth indefinitely for an account that is gone.
      expect(series.some((row) => row.date === TODAY && row.balance !== 0n)).toBe(false)
    })

    it('still reports the balance it held before it closed', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 50_000n,
          coverageStart: '2026-07-31',
          closedOn: '2026-08-01',
        })

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return await readSeries(ctx, accountId)
      })

      // The money was real on the days it was there. That is the whole point of importing it.
      expect(series.find((row) => row.date === '2026-07-31')?.balance).toBe(50_000n)
    })

    it('leaves an open account carried forward as before', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 50_000n,
          coverageStart: '2026-07-31',
          balanceAsOf: new Date('2026-08-01T12:00:00.000Z'),
        })

        await rebuildAccountHistory(ctx, accountId, TODAY)
        return await readSeries(ctx, accountId)
      })

      expect(series.at(-1)?.date).toBe(TODAY)
      expect(series.at(-1)?.balance).toBe(50_000n)
    })
  })

  describe('the household-wide daily job', () => {
    it('rebuilds every confirmed account regardless of type', async () => {
      const results = await withHouseholdContext(deps, USER, async (ctx) => {
        await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        await makeAccount(ctx, { type: 'investment', balanceCents: 500_000n })
        await makeAccount(ctx, { type: 'credit', balanceCents: -25_000n })

        return rebuildHouseholdHistory(ctx, TODAY)
      })

      expect(results).toHaveLength(3)
      expect(results.every((r) => r.snapshotsWritten > 0)).toBe(true)
      expect(results.every((r) => r.consistent)).toBe(true)
    })

    it('skips closed accounts', async () => {
      const results = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        await ctx.client.query('update accounts set is_closed = true where id = $1', [accountId])
        return rebuildHouseholdHistory(ctx, TODAY)
      })

      expect(results).toEqual([])
    })

    it('is idempotent', async () => {
      const [first, second] = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx, { type: 'depository', balanceCents: 100_000n })
        await addTransaction(ctx, accountId, '2026-08-02', -5_000n)

        await rebuildAccountHistory(ctx, accountId, TODAY)
        const a = await readSeries(ctx, accountId)

        await rebuildAccountHistory(ctx, accountId, TODAY)
        const b = await readSeries(ctx, accountId)

        return [a, b]
      })

      expect(second).toEqual(first)
    })
  })

  /**
   * Trusting imported history, and being able to stop.
   *
   * The setting widens how far back a chart is drawn: normally the series starts where the provider
   * vouches for it, and with trust on it starts at the earliest transaction on the account.
   *
   * The property that matters most is the **last** test here. `coverage_start_date` is only ever
   * read by this path, never written — so turning the setting off has to restore the previous chart
   * exactly, not approximately. If it overwrote the boundary the choice would be one-way, and the
   * whole point is that somebody can look at what it draws and change their mind.
   */
  describe('trusting imported history', () => {
    async function setTrust(context: HouseholdContext, trust: boolean): Promise<void> {
      await context.client.query('update households set trust_imported_history = $1 where id = $2', [
        trust,
        context.householdId,
      ])
    }

    /** Coverage says the 31st; the transactions reach back to the 20th. */
    async function seed(context: HouseholdContext): Promise<string> {
      const accountId = await makeAccount(context, {
        type: 'depository',
        balanceCents: 100_000n,
        coverageStart: '2026-07-31',
      })

      await addTransaction(context, accountId, '2026-07-20', -5_000n)
      await addTransaction(context, accountId, '2026-07-25', -3_000n)
      return accountId
    }

    it('draws only from the declared boundary when the setting is off', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        await setTrust(ctx, false)
        const accountId = await seed(ctx)
        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series[0]?.date).toBe('2026-07-31')
    })

    it('reaches back to the earliest transaction when the setting is on', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        await setTrust(ctx, true)
        const accountId = await seed(ctx)
        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series[0]?.date).toBe('2026-07-20')
    })

    /** Reconstruction still has to be right over the widened stretch, not merely longer. */
    it('reconstructs the widened stretch from the transactions', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        await setTrust(ctx, true)
        const accountId = await seed(ctx)
        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      /*
       * `balance(T) = current − transactions posted *after* T`, so a spend dated T is already
       * inside that day's balance rather than subtracted from it. On the 20th only the 25th's
       * -3,000 is still to come.
       */
      expect(series[0]?.balance).toBe(103_000n)
      // Nothing posts after the 25th, so it already equals the current balance.
      expect(series.find((point) => point.date === '2026-07-25')?.balance).toBe(100_000n)
    })

    /** The guarantee. Off again must be byte-for-byte what it was, not merely shorter. */
    it('restores the original series exactly when turned back off', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        await setTrust(ctx, false)
        const accountId = await seed(ctx)
        await rebuildAccountHistory(ctx, accountId, TODAY)
        const before = await readSeries(ctx, accountId)

        await setTrust(ctx, true)
        await rebuildAccountHistory(ctx, accountId, TODAY)
        const widened = await readSeries(ctx, accountId)

        await setTrust(ctx, false)
        await rebuildAccountHistory(ctx, accountId, TODAY)
        const after = await readSeries(ctx, accountId)

        return { before, widened, after }
      })

      expect(result.widened.length).toBeGreaterThan(result.before.length)
      expect(result.after).toEqual(result.before)
    })

    /** Nothing to widen to is not an error — it simply stays where it was. */
    it('leaves an account with no earlier transactions alone', async () => {
      const series = await withHouseholdContext(deps, USER, async (ctx) => {
        await setTrust(ctx, true)
        const accountId = await makeAccount(ctx, {
          type: 'depository',
          balanceCents: 100_000n,
          coverageStart: '2026-07-31',
        })
        await rebuildAccountHistory(ctx, accountId, TODAY)
        return readSeries(ctx, accountId)
      })

      expect(series[0]?.date).toBe('2026-07-31')
    })
  })
})
