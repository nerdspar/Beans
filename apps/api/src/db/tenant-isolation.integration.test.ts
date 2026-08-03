import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { Pool } from 'pg'
import { DataKey } from '../crypto/data-key.js'
import { DecryptionError } from '../crypto/envelope.js'
import { HouseholdCipher } from '../crypto/household-cipher.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'

/**
 * Tenant isolation. **The most important tests in the repo.**
 *
 * These run against a real Postgres — never a mock, never SQLite — because what is being tested is
 * Postgres's own row-level security behavior, which no mock can meaningfully stand in for.
 *
 * Requires TEST_DATABASE_URL and migrations applied:
 *     pnpm db:migrate:test && pnpm test:integration
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']

// Fixed ids. Deterministic fixtures, never random (CLAUDE.md).
const HOUSEHOLD_A = '11111111-1111-4111-8111-111111111111'
const HOUSEHOLD_B = '22222222-2222-4222-8222-222222222222'

const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('tenant isolation', () => {
  let pool: Pool

  /**
   * Runs `fn` with `app.current_household` set for the duration of one transaction — exactly how
   * the repository layer will scope every request.
   *
   * `set_config(..., true)` is transaction-local, so the setting cannot leak onto a pooled
   * connection and silently widen a later request's visibility.
   */
  async function asHousehold<T>(
    householdId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      if (householdId !== null) {
        await client.query('select set_config($1, $2, true)', [
          'app.current_household',
          householdId,
        ])
      }
      const result = await fn(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async function seedHousehold(householdId: string, accountName: string): Promise<void> {
    const provider = LocalMasterKeyProvider.fromObject({
      currentVersion: 1,
      keys: { 1: MASTER_KEY },
    })
    const dek = DataKey.generate()
    const wrapped = await provider.wrapDEK(dek, householdId)
    const cipher = new HouseholdCipher(householdId, dek)

    await asHousehold(householdId, async (client) => {
      await client.query(
        'insert into households (id, name, wrapped_dek, key_version) values ($1, $2, $3, $4)',
        [householdId, `Household ${accountName}`, wrapped.wrapped, wrapped.keyVersion],
      )
      await client.query(
        `insert into accounts (household_id, type, display_name, current_balance, currency)
         values ($1, 'depository', $2, $3, 'USD')`,
        [householdId, cipher.encryptText(accountName), cipher.encryptMoney(123456n)],
      )
    })
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })

    // Fail loudly rather than testing nothing: if the app role could bypass RLS, every assertion
    // below would pass for the wrong reason.
    const { rows } = await pool.query(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    )
    expect(rows[0].rolsuper, 'test role must not be a superuser').toBe(false)
    expect(rows[0].rolbypassrls, 'test role must not have BYPASSRLS').toBe(false)
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    // Truncate as the table owner. RLS applies to DELETE but not TRUNCATE.
    await pool.query('truncate households, accounts, categories restart identity cascade')
    await seedHousehold(HOUSEHOLD_A, 'Chase Checking')
    await seedHousehold(HOUSEHOLD_B, 'Wells Fargo Savings')
  })

  describe('reads', () => {
    it('sees only its own accounts', async () => {
      const a = await asHousehold(HOUSEHOLD_A, (c) => c.query('select household_id from accounts'))
      expect(a.rowCount).toBe(1)
      expect(a.rows[0].household_id).toBe(HOUSEHOLD_A)

      const b = await asHousehold(HOUSEHOLD_B, (c) => c.query('select household_id from accounts'))
      expect(b.rowCount).toBe(1)
      expect(b.rows[0].household_id).toBe(HOUSEHOLD_B)
    })

    it('sees only its own household row', async () => {
      const result = await asHousehold(HOUSEHOLD_A, (c) => c.query('select id from households'))
      expect(result.rows.map((r) => r.id)).toEqual([HOUSEHOLD_A])
    })

    it('returns nothing when explicitly querying another household by id', async () => {
      // The attack this defends against: a repository bug that takes a household id from user
      // input. RLS must make the explicit WHERE useless.
      const result = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query('select * from accounts where household_id = $1', [HOUSEHOLD_B]),
      )
      expect(result.rowCount).toBe(0)
    })

    it('fails closed when no household context is set', async () => {
      // current_setting(..., true) yields NULL, and `household_id = NULL` is NULL, not true.
      // A request that forgot to scope itself sees nothing rather than everything.
      const result = await asHousehold(null, (c) => c.query('select * from accounts'))
      expect(result.rowCount).toBe(0)
    })

    it('cannot be widened by a UNION across households', async () => {
      const result = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query(
          `select household_id from accounts where household_id = $1
           union all
           select household_id from accounts where household_id = $2`,
          [HOUSEHOLD_A, HOUSEHOLD_B],
        ),
      )
      expect(result.rows.map((r) => r.household_id)).toEqual([HOUSEHOLD_A])
    })
  })

  describe('writes', () => {
    it('cannot insert a row belonging to another household', async () => {
      await expect(
        asHousehold(HOUSEHOLD_A, (c) =>
          c.query(
            `insert into accounts (household_id, type, currency) values ($1, 'depository', 'USD')`,
            [HOUSEHOLD_B],
          ),
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    it('cannot update another household rows', async () => {
      const result = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query('update accounts set is_closed = true where household_id = $1', [HOUSEHOLD_B]),
      )
      // Not an error — simply invisible, so zero rows match.
      expect(result.rowCount).toBe(0)

      const stillOpen = await asHousehold(HOUSEHOLD_B, (c) =>
        c.query('select is_closed from accounts'),
      )
      expect(stillOpen.rows[0].is_closed).toBe(false)
    })

    it('cannot delete another household rows', async () => {
      const result = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query('delete from accounts where household_id = $1', [HOUSEHOLD_B]),
      )
      expect(result.rowCount).toBe(0)

      const survivors = await asHousehold(HOUSEHOLD_B, (c) => c.query('select 1 from accounts'))
      expect(survivors.rowCount).toBe(1)
    })

    it('cannot move a row into another household', async () => {
      await expect(
        asHousehold(HOUSEHOLD_A, (c) =>
          c.query('update accounts set household_id = $1', [HOUSEHOLD_B]),
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  describe('encryption is a second, independent barrier', () => {
    it('cannot decrypt another household ciphertext even holding the row and a key', async () => {
      const dek = DataKey.generate()
      const cipherA = new HouseholdCipher(HOUSEHOLD_A, dek)
      const cipherB = new HouseholdCipher(HOUSEHOLD_B, dek)

      const sealed = cipherA.encryptMoney(-82487123n)

      // Even sharing a DEK — a worse compromise than any realistic leak — the household id bound
      // as AAD makes the value unreadable in the wrong tenant's context.
      expect(() => cipherB.decryptMoney(sealed)).toThrow(DecryptionError)
    })

    it('stores balances as ciphertext, not readable values', async () => {
      const result = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query('select current_balance, display_name from accounts'),
      )
      const balance = result.rows[0].current_balance as Buffer
      const name = result.rows[0].display_name as Buffer

      expect(Buffer.isBuffer(balance)).toBe(true)
      expect(balance.toString('utf8')).not.toContain('123456')
      expect(name.toString('utf8')).not.toContain('Chase')
    })
  })

  describe('schema invariants enforced by the database', () => {
    it('rejects categories nested three deep', async () => {
      await asHousehold(HOUSEHOLD_A, async (client) => {
        const parent = await client.query(
          `insert into categories (household_id, slug, name, kind) values ($1,'income','Income','income') returning id`,
          [HOUSEHOLD_A],
        )
        const child = await client.query(
          `insert into categories (household_id, slug, name, kind, parent_id) values ($1,'salary','Salary','income',$2) returning id`,
          [HOUSEHOLD_A, parent.rows[0].id],
        )

        await expect(
          client.query(
            `insert into categories (household_id, slug, name, kind, parent_id) values ($1,'bonus','Bonus','income',$2)`,
            [HOUSEHOLD_A, child.rows[0].id],
          ),
        ).rejects.toThrow(/at most two levels/)
      })
    })

    it('rejects giving a parent to a category that already has children', async () => {
      await asHousehold(HOUSEHOLD_A, async (client) => {
        const top = await client.query(
          `insert into categories (household_id, slug, name, kind) values ($1,'expenses','Expenses','expense') returning id`,
          [HOUSEHOLD_A],
        )
        await client.query(
          `insert into categories (household_id, slug, name, kind, parent_id) values ($1,'food','Food','expense',$2)`,
          [HOUSEHOLD_A, top.rows[0].id],
        )
        const other = await client.query(
          `insert into categories (household_id, slug, name, kind) values ($1,'other','Other','expense') returning id`,
          [HOUSEHOLD_A],
        )

        // `expenses` has children, so it may not itself become a child.
        await expect(
          client.query('update categories set parent_id = $1 where id = $2', [
            other.rows[0].id,
            top.rows[0].id,
          ]),
        ).rejects.toThrow(/at most two levels/)
      })
    })

    it('allows the same child name under different parents', async () => {
      await asHousehold(HOUSEHOLD_A, async (client) => {
        const income = await client.query(
          `insert into categories (household_id, slug, name, kind) values ($1,'income','Income','income') returning id`,
          [HOUSEHOLD_A],
        )
        const expenses = await client.query(
          `insert into categories (household_id, slug, name, kind) values ($1,'expenses','Expenses','expense') returning id`,
          [HOUSEHOLD_A],
        )

        await client.query(
          `insert into categories (household_id, slug, name, kind, parent_id) values ($1,'income-other','Other','income',$2)`,
          [HOUSEHOLD_A, income.rows[0].id],
        )
        // "Other" under Expenses too — the reason uniqueness is scoped by parent.
        await expect(
          client.query(
            `insert into categories (household_id, slug, name, kind, parent_id) values ($1,'expense-other','Other','expense',$2)`,
            [HOUSEHOLD_A, expenses.rows[0].id],
          ),
        ).resolves.toBeDefined()
      })
    })

    it('rejects two top-level categories with the same name (NULLS NOT DISTINCT)', async () => {
      await asHousehold(HOUSEHOLD_A, async (client) => {
        await client.query(
          `insert into categories (household_id, slug, name, kind) values ($1,'other-1','Other','expense')`,
          [HOUSEHOLD_A],
        )
        // Without NULLS NOT DISTINCT, Postgres would treat the two NULL parent_ids as distinct
        // and allow this duplicate.
        await expect(
          client.query(
            `insert into categories (household_id, slug, name, kind) values ($1,'other-2','Other','expense')`,
            [HOUSEHOLD_A],
          ),
        ).rejects.toThrow(/duplicate key|unique/i)
      })
    })

    it('refuses to change a system category slug', async () => {
      await asHousehold(HOUSEHOLD_A, async (client) => {
        await client.query(
          `insert into categories (household_id, slug, name, kind, is_system) values ($1,'groceries','Groceries','expense',true)`,
          [HOUSEHOLD_A],
        )

        // Renaming the label is fine...
        await expect(
          client.query(`update categories set name = 'Food' where slug = 'groceries'`),
        ).resolves.toBeDefined()

        // ...but the slug is what rules and import presets reference, so it cannot move.
        await expect(
          client.query(`update categories set slug = 'food' where slug = 'groceries'`),
        ).rejects.toThrow(/immutable/)
      })
    })

    it('maintains updated_at by trigger, not application code', async () => {
      const before = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query('select id, updated_at from accounts'),
      )

      const updated = await asHousehold(HOUSEHOLD_A, (c) =>
        c.query('update accounts set is_closed = true returning updated_at'),
      )

      // The UPDATE never mentioned updated_at. Delta sync depends on this being impossible to
      // forget, which is why it lives in the database.
      expect(new Date(updated.rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].updated_at).getTime(),
      )
    })
  })
})
