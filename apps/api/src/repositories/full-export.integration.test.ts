import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { exportEverything } from './full-export.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from './household-context.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'

/**
 * The document the native app imports when Beans leaves the server.
 *
 * What these guard, in order of how badly it would go wrong:
 * - another household's data in the file (isolation layer 1 and RLS both apply here);
 * - a member's **private** account, or anything beneath it, in the other member's file (§6.4);
 * - the SimpleFIN access URL anywhere in it (§10);
 * - the server's derived history arriving as if it were observed, which the native app would then
 *   treat as an input and never rebuild.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x44).toString('base64')

const USER = 'full-export-user-fixed-id'
const PARTNER = 'full-export-partner-fixed-id'
const OTHER_USER = 'full-export-other-user-fixed-id'
const NOW = new Date('2026-10-13T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('full export', () => {
  let pool: Pool
  let deps: ContextDependencies

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
    for (const [id, email] of [
      [USER, 'full-export@example.com'],
      [PARTNER, 'full-export-partner@example.com'],
      [OTHER_USER, 'full-export-other@example.com'],
    ]) {
      await pool.query(
        'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
        [id, 'Test User', email],
      )
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER, OTHER_USER])
    await createHousehold(deps, USER, 'The Goldbergs')
    await createHousehold(deps, OTHER_USER, 'Someone Else')
    await withHouseholdContext(deps, USER, (context) =>
      context.client.query(
        `insert into household_members (household_id, user_id, role) values ($1, $2, 'member')`,
        [context.householdId, PARTNER],
      ),
    )
  })

  async function account(
    context: HouseholdContext,
    name: string,
    options: { private?: boolean; type?: string } = {},
  ): Promise<string> {
    const result = await context.client.query<{ id: string }>(
      `insert into accounts
         (household_id, type, provider_name, current_balance, is_manual, confirmed_at, is_shared, owner_user_id)
       values ($1, $2, $3, $4, false, $5, $6, $7)
       returning id`,
      [
        context.householdId,
        options.type ?? 'depository',
        context.cipher.encryptText(name),
        context.cipher.encryptMoney(1_234_56n),
        NOW,
        options.private !== true,
        context.userId,
      ],
    )
    return result.rows[0]!.id
  }

  async function transaction(
    context: HouseholdContext,
    accountId: string,
    description: string,
  ): Promise<string> {
    const result = await context.client.query<{ id: string }>(
      `insert into transactions (household_id, account_id, posted_date, amount, description, pending, status, source)
       values ($1, $2, '2026-10-01', $3, $4, false, 'active', 'synced') returning id`,
      [
        context.householdId,
        accountId,
        context.cipher.encryptMoney(-52_40n),
        context.cipher.encryptText(description),
      ],
    )
    return result.rows[0]!.id
  }

  it('carries ids, decrypted names and money as decimal strings', async () => {
    const doc = await withHouseholdContext(deps, USER, async (context) => {
      const id = await account(context, 'Everyday Checking')
      await transaction(context, id, "TRADER JOE'S")
      return exportEverything(context)
    })

    const accounts = doc['accounts'] as Array<Record<string, unknown>>
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      providerName: 'Everyday Checking',
      currentBalance: '1234.56',
      isShared: true,
      ownedByMe: true,
    })
    const transactions = doc['transactions'] as Array<Record<string, unknown>>
    expect(transactions[0]).toMatchObject({
      amount: '-52.40',
      description: "TRADER JOE'S",
      postedDate: '2026-10-01',
    })
    expect(doc['version']).toBe(1)
    // No JSON numbers for money anywhere.
    expect(JSON.stringify(doc)).not.toMatch(/"(amount|balance|currentBalance)":-?\d/)
  })

  it('keeps observed and imported history, and leaves the derived history behind', async () => {
    const doc = await withHouseholdContext(deps, USER, async (context) => {
      const id = await account(context, 'Brokerage', { type: 'investment' })
      for (const [date, source] of [
        ['2026-10-01', 'observed'],
        ['2026-10-02', 'derived'],
        ['2026-10-03', 'carried'],
        ['2026-09-01', 'imported'],
      ]) {
        await context.client.query(
          `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source) values ($1, $2, $3, $4, $5)`,
          [context.householdId, id, date, context.cipher.encryptMoney(100_00n), source],
        )
      }
      return exportEverything(context)
    })
    const snapshots = doc['balanceSnapshots'] as Array<Record<string, unknown>>
    expect(snapshots.map((s) => s['source']).sort()).toEqual(['imported', 'observed'])
  })

  it("never puts a member's private account, or anything beneath it, in the other member's file", async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const shared = await account(context, 'Joint Checking')
      const hidden = await account(context, 'My Own Card', { private: true, type: 'credit' })
      const sharedTxn = await transaction(context, shared, 'SHARED COFFEE')
      const hiddenTxn = await transaction(context, hidden, 'SECRET GIFT')
      await context.client.query(
        `insert into balance_readings (household_id, account_id, as_of_date, balance) values ($1, $2, '2026-10-01', $3)`,
        [context.householdId, hidden, context.cipher.encryptMoney(-99_00n)],
      )
      await context.client.query(
        `insert into transfer_matches (household_id, from_transaction_id, to_transaction_id, pair_key, status)
         values ($1, $2, $3, $4, 'proposed')`,
        [context.householdId, sharedTxn, hiddenTxn, [sharedTxn, hiddenTxn].sort().join(':')],
      )
      await context.client.query(
        `insert into recurring_decisions (household_id, merchant_key, decision, account_id) values ($1, $2, 'subscription', $3)`,
        [context.householdId, context.cipher.encryptText('secret.example'), hidden],
      )
    })

    const partner = await withHouseholdContext(deps, PARTNER, exportEverything)
    const text = JSON.stringify(partner)
    expect((partner['accounts'] as unknown[]).length).toBe(1)
    expect(text).not.toContain('My Own Card')
    expect(text).not.toContain('SECRET GIFT')
    expect(text).not.toContain('secret.example')
    expect(partner['balanceReadings']).toEqual([])
    expect(partner['transferMatches']).toEqual([])

    // The owner sees their own private account, marked as theirs.
    const mine = await withHouseholdContext(deps, USER, exportEverything)
    const hidden = (mine['accounts'] as Array<Record<string, unknown>>).find(
      (a) => a['providerName'] === 'My Own Card',
    )
    expect(hidden).toMatchObject({ isShared: false, ownedByMe: true })
    expect(mine['transferMatches']).toHaveLength(1)
  })

  it("never contains another household's data", async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const id = await account(context, 'Goldberg Checking')
      await transaction(context, id, 'GOLDBERG ONLY')
    })
    const other = await withHouseholdContext(deps, OTHER_USER, exportEverything)
    const text = JSON.stringify(other)
    expect(text).not.toContain('Goldberg')
    expect(other['accounts']).toEqual([])
    expect(other['transactions']).toEqual([])
  })

  it('never includes the SimpleFIN access URL, not even partly', async () => {
    const doc = await withHouseholdContext(deps, USER, async (context) => {
      await context.client.query(
        `insert into connections (household_id, owner_user_id, access_url) values ($1, $2, $3)`,
        [
          context.householdId,
          context.userId,
          context.cipher.encryptText('https://user:hunter2-token@bridge.example/simplefin'),
        ],
      )
      return exportEverything(context)
    })
    const text = JSON.stringify(doc)
    expect(doc['connections']).toHaveLength(1)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('bridge.example')
    expect(text).not.toMatch(/accessUrl/i)
  })
})
