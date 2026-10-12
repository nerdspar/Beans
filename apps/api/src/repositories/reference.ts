import {
  PLACEHOLDER_VALUE,
  REFERENCE_DEFINITIONS,
  type ReferenceRow,
  type ReferenceUnit,
} from '@beans/shared'
import type { HouseholdContext } from './household-context.js'
import { RetirementError } from './retirement.js'

/**
 * Statutory reference data (ARCHITECTURE.md §19.5).
 *
 * **Global, not household-scoped.** These are figures the IRS publishes; they are the same for
 * every household and personal to nobody. The functions here still take a `HouseholdContext`, for
 * one reason only: approving a figure changes what every household in the install sees, so it is
 * an owner's action and the context is where the role lives. Nothing here filters by household,
 * and nothing should start to.
 */

/**
 * Creates the year's checklist if it is not there, and returns it.
 *
 * Idempotent, and seeded with **placeholders that are deliberately absurd** — one cent, one year.
 * The point of seeding at all is that an operator gets a concrete list of what to look up with a
 * link beside each item, rather than an empty table and a memory of a conversation. The point of
 * absurd values is that if one ever escaped the approval gate it would read as broken rather than
 * as an answer.
 */
export async function ensureReferenceYear(
  context: HouseholdContext,
  taxYear: number,
): Promise<ReferenceRow[]> {
  for (const definition of REFERENCE_DEFINITIONS) {
    await context.client.query(
      `insert into contribution_limits (tax_year, key, value, unit, source_url)
       values ($1, $2, $3, $4, $5)
       on conflict (tax_year, key) do nothing`,
      [taxYear, definition.key, PLACEHOLDER_VALUE, definition.unit, definition.sourceUrl],
    )
  }

  return readReferenceYear(context, taxYear)
}

export async function readReferenceYear(
  context: HouseholdContext,
  taxYear: number,
): Promise<ReferenceRow[]> {
  const result = await context.client.query<{
    key: string
    tax_year: number
    value: string
    unit: ReferenceUnit
    source_url: string
    retrieved_at: Date | null
    verified_at: Date | null
  }>(
    `select key, tax_year, value, unit, source_url, retrieved_at, verified_at
       from contribution_limits
      where tax_year = $1
      order by key`,
    [taxYear],
  )

  return result.rows.map((row) => ({
    key: row.key,
    taxYear: row.tax_year,
    /*
     * node-pg returns `bigint` columns as strings, because a Postgres bigint does not fit a JS
     * number. Converting through `BigInt` rather than `Number` is the difference between an exact
     * figure and a silently rounded one.
     */
    value: BigInt(row.value),
    unit: row.unit,
    sourceUrl: row.source_url,
    retrievedAt: row.retrieved_at,
    verifiedAt: row.verified_at,
  }))
}

export type ReferenceUpdate = {
  taxYear: number
  key: string
  /** The figure as read from the source, in the unit the catalogue declares. */
  value: bigint
  sourceUrl: string
}

/**
 * Records a figure and approves it in one step.
 *
 * Deliberately one operation. Saving a value and approving it separately invites a half-done state
 * where a real figure sits unapproved and an operator assumes the work is finished — and the only
 * thing worse than an unverified figure is one somebody believes is verified.
 *
 * Owner-only: this changes what every household in the install is told about tax law.
 */
export async function approveReference(
  context: HouseholdContext,
  update: ReferenceUpdate,
  approvedAt: Date,
): Promise<void> {
  if (context.role !== 'owner') {
    throw new RetirementError('Only a household owner can approve reference figures')
  }

  const result = await context.client.query(
    `update contribution_limits
        set value = $3,
            source_url = $4,
            retrieved_at = $5,
            verified_at = $5,
            verified_by = $6
      where tax_year = $1 and key = $2`,
    [
      update.taxYear,
      update.key,
      update.value,
      update.sourceUrl,
      approvedAt,
      context.userId,
    ],
  )

  if (result.rowCount === 0) throw new RetirementError('No such reference figure')
}

/**
 * Withdraws approval, putting a figure back behind the gate.
 *
 * The value is left alone on purpose: somebody un-approving a row is usually saying "this looks
 * wrong, I need to check it", and wiping what is there would destroy the thing they were about to
 * compare against.
 */
export async function revokeReference(
  context: HouseholdContext,
  taxYear: number,
  key: string,
): Promise<void> {
  if (context.role !== 'owner') {
    throw new RetirementError('Only a household owner can change reference figures')
  }

  const result = await context.client.query(
    `update contribution_limits
        set verified_at = null, verified_by = null
      where tax_year = $1 and key = $2`,
    [taxYear, key],
  )

  if (result.rowCount === 0) throw new RetirementError('No such reference figure')
}
