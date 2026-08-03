import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { DataKey } from '../crypto/data-key.js'
import type { DataKeyCache } from '../crypto/data-key-cache.js'
import { HouseholdCipher } from '../crypto/household-cipher.js'
import type { KeyProvider } from '../crypto/key-provider.js'

/**
 * The household context — isolation layer 1.
 *
 * **There is no way to reach financial data without one.** Every repository function takes a
 * context, and the only way to obtain a context is {@link withHouseholdContext}, which resolves the
 * caller's membership, opens a transaction, sets the RLS session variables, and unwraps the
 * household's key. Forgetting to scope a query is therefore not a mistake a developer can make by
 * omission — there is no unscoped path to omit it from.
 *
 * RLS (layer 2) still runs underneath all of this. The redundancy is deliberate: this layer makes
 * the right thing easy, and RLS makes the wrong thing impossible.
 */

export type HouseholdRole = 'owner' | 'member'

export type HouseholdContext = {
  householdId: string
  userId: string
  role: HouseholdRole
  /** Transaction-scoped. Valid only inside the `withHouseholdContext` callback. */
  client: PoolClient
  /** Bound to this household, so encrypted columns cannot be read or written for another tenant. */
  cipher: HouseholdCipher
}

export type ContextDependencies = {
  pool: Pool
  keyProvider: KeyProvider
  keyCache: DataKeyCache
}

export class NoHouseholdError extends Error {
  override readonly name = 'NoHouseholdError'

  constructor(userId: string) {
    super(`User ${userId} does not belong to a household`)
  }
}

/**
 * Sets a transaction-local session variable.
 *
 * `set_config(..., true)` rather than `SET` so the value dies with the transaction and cannot
 * linger on a pooled connection to widen a later request's visibility. It also takes parameters,
 * where `SET` would require string interpolation into SQL.
 */
async function setLocal(client: PoolClient, name: string, value: string): Promise<void> {
  await client.query('select set_config($1, $2, true)', [name, value])
}

/**
 * Runs `fn` inside a transaction scoped to the household the user belongs to.
 *
 * The whole callback is one transaction: the RLS variables, the reads, and the writes either all
 * happen or none do. That matters beyond the usual atomicity argument — a partially applied write
 * under a half-set session variable is precisely the state in which isolation guarantees stop
 * meaning anything.
 */
export async function withHouseholdContext<T>(
  deps: ContextDependencies,
  userId: string,
  fn: (context: HouseholdContext) => Promise<T>,
): Promise<T> {
  const client = await deps.pool.connect()

  try {
    await client.query('begin')

    // Set first: the membership lookup below depends on the `household_members_self_select`
    // policy, which is keyed to this variable.
    await setLocal(client, 'app.current_user_id', userId)

    const membership = await client.query<{ household_id: string; role: HouseholdRole }>(
      'select household_id, role from household_members where user_id = $1',
      [userId],
    )

    const row = membership.rows[0]
    if (row === undefined) {
      throw new NoHouseholdError(userId)
    }

    await setLocal(client, 'app.current_household', row.household_id)

    const cipher = new HouseholdCipher(
      row.household_id,
      await loadDataKey(deps, client, row.household_id),
    )

    const result = await fn({
      householdId: row.household_id,
      userId,
      role: row.role,
      client,
      cipher,
    })

    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Unwraps a household's DEK, via the cache when possible.
 *
 * The cache is not really a performance optimization — unwrapping is cheap. It exists to keep
 * plaintext key material resident for as short a time and in as few copies as possible while
 * avoiding an unwrap per column read.
 */
async function loadDataKey(
  deps: ContextDependencies,
  client: PoolClient,
  householdId: string,
): Promise<DataKey> {
  const cached = deps.keyCache.get(householdId)
  if (cached !== undefined) {
    return cached
  }

  const result = await client.query<{ wrapped_dek: Buffer; key_version: number }>(
    'select wrapped_dek, key_version from households where id = $1',
    [householdId],
  )

  const row = result.rows[0]
  if (row === undefined) {
    // RLS is already set to this household, so an empty result means the row genuinely does not
    // exist rather than being invisible.
    throw new Error(`Household ${householdId} not found`)
  }

  const key = await deps.keyProvider.unwrapDEK(
    { keyVersion: row.key_version, wrapped: row.wrapped_dek },
    householdId,
  )

  deps.keyCache.set(householdId, key)
  return key
}

/**
 * Creates a household and makes `userId` its owner.
 *
 * The id is generated here rather than by the database, which is what makes this possible at all:
 * the `households` RLS policy is `id = current_household`, so the session variable must be set to
 * the row's id *before* the insert that creates it. `WITH CHECK` only compares, so pointing the
 * context at a not-yet-existing id is legitimate — but it is unusual enough to be worth stating
 * outright, because it looks like a mistake to anyone reading it cold.
 *
 * Provisioning is the one operation that cannot go through `withHouseholdContext`, since by
 * definition there is no membership to resolve yet.
 */
export async function createHousehold(
  deps: ContextDependencies,
  userId: string,
  name: string,
): Promise<{ householdId: string }> {
  const householdId = randomUUID()
  const dek = DataKey.generate()
  const wrapped = await deps.keyProvider.wrapDEK(dek, householdId)

  const client = await deps.pool.connect()

  try {
    await client.query('begin')

    await setLocal(client, 'app.current_user_id', userId)
    await setLocal(client, 'app.current_household', householdId)

    await client.query(
      'insert into households (id, name, wrapped_dek, key_version) values ($1, $2, $3, $4)',
      [householdId, name, wrapped.wrapped, wrapped.keyVersion],
    )

    await client.query(
      `insert into household_members (household_id, user_id, role) values ($1, $2, 'owner')`,
      [householdId, userId],
    )

    await client.query('commit')

    deps.keyCache.set(householdId, dek)
    return { householdId }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
