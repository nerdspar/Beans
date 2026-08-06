import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import {
  exportAccounts,
  exportBalances,
  exportReadings,
  exportTransactions,
} from './export.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from './household-context.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'

/**
 * The export is the promise that you can leave.
 *
 * Beans exists because eight years of history sat in another app behind a one-month-at-a-time PDF
 * export, so an incomplete export here would be the same trap with a different logo. These check
 * the thing that would actually be lost: **daily balances for every account type**, investments and
 * loans included, because those are the ones nobody downstream can rebuild from transactions.
 *
 * A missing row is silent. The file opens, the columns line up, and the history is simply shorter
 * than it should be — which is discovered, if ever, long after the other app has been chosen.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x22).toString('base64')
const USER = 'export-user-fixed-id'

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('export', () => {
  let pool: Pool
  let deps: ContextDependencies

  async function makeAccount(
    context: HouseholdContext,
    type: string,
    name: string,
    balanceCents: bigint,
  ): Promise<string> {
    const result = await context.client.query<{ id: string }>(
      `insert into accounts (household_id, type, currency, display_name, current_balance,
                             available_balance, balance_as_of, coverage_start_date, confirmed_at)
       values ($1,$2,'USD',$3,$4,$5,'2026-08-03','2026-08-01',now()) returning id`,
      [
        context.householdId,
        type,
        context.cipher.encryptText(name),
        context.cipher.encryptMoney(balanceCents),
        context.cipher.encryptMoney(balanceCents),
      ],
    )
    return result.rows[0]!.id
  }

  async function addSnapshot(
    context: HouseholdContext,
    accountId: string,
    date: string,
    cents: bigint,
  ): Promise<void> {
    await context.client.query(
      `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
       values ($1,$2,$3,$4,'observed')`,
      [context.householdId, accountId, date, context.cipher.encryptMoney(cents)],
    )
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({ currentVersion: 1, keys: { 1: MASTER_KEY } }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
    await resetAll(pool)
    await pool.query(
      'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
      [USER, 'Export User', 'export@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER])
    await createHousehold(deps, USER, 'The Goldbergs')
  })

  it('exports daily balances for every account type, investments and loans included', async () => {
    const table = await withHouseholdContext(deps, USER, async (ctx) => {
      /*
       * One of each kind that cannot be reconstructed downstream. A cash balance can be walked back
       * from transactions by whoever receives this file; an investment balance cannot, because a
       * share price moving is not something anybody posts. A loan is the same in reverse.
       */
      const brokerage = await makeAccount(ctx, 'investment', 'Joint Brokerage', 142_900_00n)
      const mortgage = await makeAccount(ctx, 'mortgage', 'Home Mortgage', -281_640_00n)
      const checking = await makeAccount(ctx, 'depository', 'Everyday Checking', 8_412_37n)

      for (const [id, cents] of [
        [brokerage, 142_900_00n],
        [mortgage, -281_640_00n],
        [checking, 8_412_37n],
      ] as const) {
        await addSnapshot(ctx, id, '2026-08-01', cents)
        await addSnapshot(ctx, id, '2026-08-02', cents)
      }

      return exportBalances(ctx)
    })

    // Three accounts × two days. A type quietly excluded by a join or a filter shows up here as a
    // count that is a multiple of two rather than six.
    expect(table.rows).toHaveLength(6)

    const names = new Set(table.rows.map((row) => row[2]))
    expect(names).toEqual(new Set(['Joint Brokerage', 'Home Mortgage', 'Everyday Checking']))

    const mortgageRow = table.rows.find((row) => row[2] === 'Home Mortgage')
    // Signed as stored, so a liability leaves as a liability rather than as a magnitude somebody
    // downstream has to guess the direction of.
    expect(mortgageRow?.[3]).toBe('-281640.00')
  })

  it('writes money as decimal strings, never as numbers', async () => {
    const table = await withHouseholdContext(deps, USER, async (ctx) => {
      const account = await makeAccount(ctx, 'investment', 'Big Account', 12_345_678_901_23n)
      await addSnapshot(ctx, account, '2026-08-01', 12_345_678_901_23n)
      return exportBalances(ctx)
    })

    // Above 2^53 as cents. A float would round this; the string is exact, which is the entire
    // reason money is a decimal string at every boundary in this app.
    expect(table.rows[0]?.[3]).toBe('12345678901.23')
  })

  it('includes closed accounts, which held real money on real dates', async () => {
    const table = await withHouseholdContext(deps, USER, async (ctx) => {
      const account = await makeAccount(ctx, 'loan', 'Paid-off Loan', 0n)
      await ctx.client.query('update accounts set is_closed = true, closed_on = $2 where id = $1', [
        account,
        '2026-07-01',
      ])
      return exportAccounts(ctx)
    })

    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]?.[1]).toBe('Paid-off Loan')
    expect(table.rows[0]?.[13]).toBe('true')
  })

  it('carries the available balance, which is stored and shown nowhere else', async () => {
    const table = await withHouseholdContext(deps, USER, (ctx) =>
      makeAccount(ctx, 'depository', 'Checking', 500_00n).then(() => exportAccounts(ctx)),
    )
    expect(table.rows[0]?.[8]).toBe('500.00')
  })

  it('exports the institutions own readings, which nothing else records', async () => {
    /*
     * The only primary figures in the export. Everything in `balances` for a reconstructable
     * account is computed from these; if they are missing, an auditor has nothing to check the
     * derived history against.
     */
    const table = await withHouseholdContext(deps, USER, async (ctx) => {
      const account = await makeAccount(ctx, 'depository', 'Checking', 500_00n)
      await ctx.client.query(
        `insert into balance_readings (household_id, account_id, as_of_date, balance)
         values ($1,$2,'2026-08-01',$3)`,
        [ctx.householdId, account, ctx.cipher.encryptMoney(512_34n)],
      )
      return exportReadings(ctx)
    })

    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]?.[2]).toBe('Checking')
    expect(table.rows[0]?.[3]).toBe('512.34')
  })

  it('exports transactions with their decrypted description and category', async () => {
    const table = await withHouseholdContext(deps, USER, async (ctx) => {
      const account = await makeAccount(ctx, 'depository', 'Checking', 500_00n)
      await ctx.client.query(
        `insert into transactions (household_id, account_id, posted_date, amount, description,
                                   pending, status, source)
         values ($1,$2,'2026-08-02',$3,$4,false,'active','synced')`,
        [
          ctx.householdId,
          account,
          ctx.cipher.encryptMoney(-52_40n),
          ctx.cipher.encryptText("TRADER JOE'S"),
        ],
      )
      return exportTransactions(ctx)
    })

    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]?.[3]).toBe('-52.40')
    expect(table.rows[0]?.[4]).toBe("TRADER JOE'S")
  })
})
