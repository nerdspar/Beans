import { createHash, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { ContextDependencies, HouseholdContext, HouseholdRole } from './household-context.js'

/**
 * Household invites.
 *
 * Invites are **copy-paste links**, always. Mail is optional in a self-hosted install, so
 * onboarding can never depend on it — if a mailer is configured the link is also emailed, but the
 * link is the mechanism and the email is a convenience.
 */

/** Long enough that guessing is hopeless; the hash is what's stored. */
const TOKEN_BYTES = 32

const DEFAULT_EXPIRY_DAYS = 14

export class InviteError extends Error {
  override readonly name = 'InviteError'
}

export type CreatedInvite = {
  /** The raw token. Returned **once**, at creation, and never recoverable afterwards. */
  token: string
  expiresAt: Date
}

/**
 * Only the hash is stored, exactly as with a password.
 *
 * A stolen database dump therefore cannot be used to accept outstanding invites — which matters
 * because an invite is a capability to join a household and read its finances.
 *
 * SHA-256 rather than a password hash: the token is 256 bits of entropy from a CSPRNG, so there is
 * no dictionary to attack and key stretching would buy nothing.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createInvite(
  context: HouseholdContext,
  options: { role?: HouseholdRole; email?: string; expiresInDays?: number } = {},
): Promise<CreatedInvite> {
  if (context.role !== 'owner') {
    throw new InviteError('Only a household owner can invite members')
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const role = options.role ?? 'member'
  const expiresAt = new Date(
    Date.now() + (options.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
  )

  await context.client.query(
    `insert into household_invites
       (household_id, token_hash, role, email, expires_at, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      context.householdId,
      hashToken(token),
      role,
      // Encrypted: an invitee's address is personal data belonging to this household.
      options.email === undefined ? null : context.cipher.encryptText(options.email),
      expiresAt,
      context.userId,
    ],
  )

  return { token, expiresAt }
}

type InviteRow = {
  id: string
  household_id: string
  role: HouseholdRole
  expires_at: Date
  accepted_at: Date | null
}

/**
 * Accepts an invite, joining the user to the household.
 *
 * Cannot go through `withHouseholdContext` — the whole point is that the caller has no household
 * yet. Instead the token itself bootstraps the scope, via the `household_invites_by_token_select`
 * policy.
 *
 * The entire operation is one transaction: validating the invite, marking it consumed, and
 * creating the membership either all happen or none do. A half-applied accept would leave an
 * invite that looks used but grants nothing, or a membership with no audit trail.
 */
export async function acceptInvite(
  deps: ContextDependencies,
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<{ householdId: string; role: HouseholdRole }> {
  const client = await deps.pool.connect()

  try {
    await client.query('begin')

    // Step 1: find the invite using only the token. This is the bootstrap — no household scope
    // exists yet, so the token-hash policy is the only thing making the row visible.
    const found = await findInviteByToken(client, token)

    if (found === null) {
      // Deliberately the same message for "no such invite" and "expired": distinguishing them
      // tells a probing caller which tokens once existed.
      throw new InviteError('This invite link is not valid')
    }

    await client.query('select set_config($1, $2, true)', ['app.current_user_id', userId])
    await client.query('select set_config($1, $2, true)', [
      'app.current_household',
      found.household_id,
    ])

    /**
     * Step 2: re-read under a row lock, now that the household scope is set.
     *
     * The lock has to come second. `SELECT ... FOR UPDATE` requires the row to satisfy the
     * **UPDATE** policy as well as the SELECT one, and the token-hash policy is select-only — so
     * locking during step 1 would have found nothing, with the row silently invisible rather than
     * an error. Two concurrent accepts of the same invite now serialize here, and the loser fails
     * the `accepted_at` check below.
     */
    const locked = await client.query<InviteRow>(
      `select id, household_id, role, expires_at, accepted_at
         from household_invites
        where id = $1
        for update`,
      [found.id],
    )

    const invite = locked.rows[0]
    if (invite === undefined) {
      throw new InviteError('This invite link is not valid')
    }
    if (invite.accepted_at !== null) {
      throw new InviteError('This invite has already been used')
    }
    if (invite.expires_at.getTime() <= now.getTime()) {
      throw new InviteError('This invite link has expired')
    }

    // v1 allows one household per user, enforced by unique(user_id) on household_members. Checked
    // here too so the failure is an explanation rather than a constraint violation.
    const existing = await client.query('select 1 from household_members where user_id = $1', [
      userId,
    ])
    if (existing.rowCount !== null && existing.rowCount > 0) {
      throw new InviteError('You already belong to a household')
    }

    await client.query(
      'insert into household_members (household_id, user_id, role) values ($1, $2, $3)',
      [invite.household_id, userId, invite.role],
    )

    // Marking it accepted inside the same transaction is what makes an invite single-use: a second
    // concurrent accept blocks on this row and then fails the `accepted_at` check.
    await client.query(
      'update household_invites set accepted_at = $1, accepted_by_user_id = $2 where id = $3',
      [now, userId, invite.id],
    )

    await client.query('commit')

    return { householdId: invite.household_id, role: invite.role }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Looks up an invite by its token alone, with no household scope.
 *
 * The RLS policy matches on the token hash, so the only row a caller can ever see is the one whose
 * token they hold. No lock here — see the note in {@link acceptInvite} about why locking has to
 * wait until the household scope is set.
 */
async function findInviteByToken(client: PoolClient, token: string): Promise<InviteRow | null> {
  const tokenHash = hashToken(token)

  await client.query('select set_config($1, $2, true)', ['app.invite_token_hash', tokenHash])

  const result = await client.query<InviteRow>(
    `select id, household_id, role, expires_at, accepted_at
       from household_invites
      where token_hash = $1`,
    [tokenHash],
  )

  return result.rows[0] ?? null
}

/** Invites for the current household, for the members screen. The token is never recoverable. */
export async function listInvites(context: HouseholdContext): Promise<
  Array<{
    id: string
    role: HouseholdRole
    email: string | null
    expiresAt: Date
    acceptedAt: Date | null
  }>
> {
  const result = await context.client.query<{
    id: string
    role: HouseholdRole
    email: Buffer | null
    expires_at: Date
    accepted_at: Date | null
  }>(
    `select id, role, email, expires_at, accepted_at
       from household_invites
      where household_id = $1
      order by created_at desc`,
    [context.householdId],
  )

  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    email: context.cipher.decryptTextOrNull(row.email),
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
  }))
}

/** Revokes an unaccepted invite. Accepted ones stay as an audit record of who joined how. */
export async function revokeInvite(context: HouseholdContext, inviteId: string): Promise<void> {
  if (context.role !== 'owner') {
    throw new InviteError('Only a household owner can revoke an invite')
  }

  await context.client.query(
    'delete from household_invites where id = $1 and household_id = $2 and accepted_at is null',
    [inviteId, context.householdId],
  )
}

export function inviteLink(publicUrl: string, token: string): string {
  return `${publicUrl}/join/${token}`
}
