import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from './household-context.js'
import { InviteError, acceptInvite, createInvite, listInvites, revokeInvite } from './invites.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const OWNER = 'owner-fixed-id'
const INVITEE = 'invitee-fixed-id'
const OUTSIDER = 'outsider-fixed-id'

// Fixed dates. Never the wall clock (CLAUDE.md).
const NOW = new Date('2026-08-03T12:00:00.000Z')
const LATER = new Date('2026-09-03T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('household invites', () => {
  let pool: Pool
  let deps: ContextDependencies

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({
        currentVersion: 1,
        keys: { 1: MASTER_KEY },
      }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  const users = [OWNER, INVITEE, OUTSIDER] as const

  beforeAll(async () => {
    await resetAll(pool)

    for (const [id, email] of [
      [OWNER, 'owner@example.com'],
      [INVITEE, 'invitee@example.com'],
      [OUTSIDER, 'outsider@example.com'],
    ]) {
      await pool.query(
        'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
        [id, 'Test User', email],
      )
    }
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, users)
  })

  async function inviteFrom(userId: string, email?: string): Promise<string> {
    return withHouseholdContext(deps, userId, async (ctx) => {
      const invite = await createInvite(ctx, email === undefined ? {} : { email })
      return invite.token
    })
  }

  it('lets an invitee join the household', async () => {
    const { householdId } = await createHousehold(deps, OWNER, 'The Goldbergs')
    const token = await inviteFrom(OWNER)

    const result = await acceptInvite(deps, INVITEE, token, NOW)

    expect(result.householdId).toBe(householdId)
    expect(result.role).toBe('member')

    // And the invitee can now actually reach the household's data.
    const seen = await withHouseholdContext(deps, INVITEE, async (ctx) => ctx.householdId)
    expect(seen).toBe(householdId)
  })

  it('gives the invitee the same key, so they can read existing data', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')

    await withHouseholdContext(deps, OWNER, async (ctx) => {
      await ctx.client.query(
        `insert into accounts (household_id, type, display_name, current_balance, currency)
         values ($1, 'depository', $2, $3, 'USD')`,
        [
          ctx.householdId,
          ctx.cipher.encryptText('Joint Checking'),
          ctx.cipher.encryptMoney(54770n),
        ],
      )
    })

    await acceptInvite(deps, INVITEE, await inviteFrom(OWNER), NOW)

    const readByInvitee = await withHouseholdContext(deps, INVITEE, async (ctx) => {
      const rows = await ctx.client.query('select display_name, current_balance from accounts')
      const row = rows.rows[0]
      return {
        name: ctx.cipher.decryptText(row.display_name as Buffer),
        balance: ctx.cipher.decryptMoney(row.current_balance as Buffer),
      }
    })

    expect(readByInvitee).toEqual({ name: 'Joint Checking', balance: 54770n })
  })

  it('stores only the hash, so a database dump cannot redeem outstanding invites', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    const token = await inviteFrom(OWNER)

    const storedHash = await withHouseholdContext(deps, OWNER, async (ctx) => {
      const rows = await ctx.client.query<{ token_hash: string }>(
        'select token_hash from household_invites',
      )
      return rows.rows[0]?.token_hash
    })

    expect(storedHash).not.toBe(token)
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a token that was never issued', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')

    await expect(acceptInvite(deps, INVITEE, 'not-a-real-token', NOW)).rejects.toThrow(/not valid/)
  })

  it('rejects an expired invite', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    const token = await inviteFrom(OWNER)

    // Default expiry is 14 days; LATER is a month out.
    await expect(acceptInvite(deps, INVITEE, token, LATER)).rejects.toThrow(/expired/)
  })

  it('is single use', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    const token = await inviteFrom(OWNER)

    await acceptInvite(deps, INVITEE, token, NOW)
    await expect(acceptInvite(deps, OUTSIDER, token, NOW)).rejects.toThrow(/already been used/)

    // ...and the second user did not sneak in.
    const members = await withHouseholdContext(deps, OWNER, async (ctx) => {
      const rows = await ctx.client.query<{ user_id: string }>(
        'select user_id from household_members',
      )
      return rows.rows.map((r) => r.user_id).sort()
    })
    expect(members).toEqual([INVITEE, OWNER].sort())
  })

  it('refuses a user who already belongs to a household', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    await createHousehold(deps, OUTSIDER, 'Another Household')

    await expect(acceptInvite(deps, OUTSIDER, await inviteFrom(OWNER), NOW)).rejects.toThrow(
      /already belong/,
    )
  })

  it('only lets an owner invite', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    await acceptInvite(deps, INVITEE, await inviteFrom(OWNER), NOW)

    // INVITEE joined as a member, not an owner.
    await expect(
      withHouseholdContext(deps, INVITEE, async (ctx) => createInvite(ctx, {})),
    ).rejects.toThrow(InviteError)
  })

  it('encrypts the invitee email', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    await inviteFrom(OWNER, 'someone@example.com')

    // Read the raw column inside a household context — a bare pool query would see nothing at all,
    // since RLS is doing its job.
    const ciphertext = await withHouseholdContext(deps, OWNER, async (ctx) => {
      const rows = await ctx.client.query<{ email: Buffer }>('select email from household_invites')
      return rows.rows[0]?.email
    })

    expect(ciphertext).toBeDefined()
    expect(ciphertext?.toString('utf8')).not.toContain('someone@example.com')

    const listed = await withHouseholdContext(deps, OWNER, async (ctx) => listInvites(ctx))
    expect(listed[0]?.email).toBe('someone@example.com')
  })

  it('revokes an unaccepted invite', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    const token = await inviteFrom(OWNER)

    await withHouseholdContext(deps, OWNER, async (ctx) => {
      const [invite] = await listInvites(ctx)
      await revokeInvite(ctx, invite!.id)
    })

    await expect(acceptInvite(deps, INVITEE, token, NOW)).rejects.toThrow(/not valid/)
  })

  it('does not expose invites belonging to another household', async () => {
    await createHousehold(deps, OWNER, 'The Goldbergs')
    await createHousehold(deps, OUTSIDER, 'Another Household')
    await inviteFrom(OWNER)

    const seenByOutsider = await withHouseholdContext(deps, OUTSIDER, async (ctx) =>
      listInvites(ctx),
    )
    expect(seenByOutsider).toEqual([])
  })
})
