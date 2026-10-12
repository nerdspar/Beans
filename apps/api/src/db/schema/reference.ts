import { bigint, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { primaryId } from './columns.js'
import { referenceUnit } from './enums.js'

/**
 * Statutory reference data: contribution limits, phaseout thresholds, catch-up tiers, RMD ages.
 *
 * **The one table in the schema with no `household_id` and no RLS**, deliberately. These are
 * published figures that are the same for every household in the world, so scoping them to a
 * tenant would mean storing one copy per household and getting them out of step. Nothing personal
 * is in here and nothing in here is derived from anybody's data — a dump of this table tells you
 * what the IRS already publishes.
 *
 * Because it is the exception, it is in its own file rather than hidden among the tenant tables,
 * so nobody copies a neighbouring table and inherits "no RLS" by accident.
 *
 * ---
 *
 * **Nothing may compute a figure from a row until `verified_at` is set.** That is the whole design.
 * These numbers change every year, several have phased in on staggered schedules with at least one
 * delay along the way, and a model's recollection of them is exactly wrong enough to be dangerous —
 * a wrong limit produces a confident, incorrect statement about somebody's real money.
 *
 * So the rows exist unverified, carrying placeholder values that are deliberately **not** plausible,
 * and every reader refuses them until a human has checked each one against the source and approved
 * it. A missing or unverified year produces a visible "not yet updated" state, never a silent
 * fallback to last year's number.
 */
export const contributionLimits = pgTable(
  'contribution_limits',
  {
    id: primaryId(),

    /** The tax year this figure applies to. Figures are never carried between years. */
    taxYear: integer('tax_year').notNull(),

    /** Stable identifier, e.g. `employee_deferral_limit`. Code looks these up by name. */
    key: text('key').notNull(),

    /**
     * The figure itself, as a plain integer in whatever `unit` says.
     *
     * `bigint`, not `bytea`: this is public data, so encrypting it would buy nothing and cost the
     * ability to read the table with a query. It is still integer-only, because a limit in cents
     * and a float are the same mistake here as anywhere else.
     */
    value: bigint('value', { mode: 'bigint' }).notNull(),

    /**
     * What the number means. Checked on every read.
     *
     * An age read as cents, or a percentage read as an age, is the kind of mistake that produces a
     * confident wrong answer rather than an error — and in a table holding both, it is only a
     * matter of time. The lookup asserts the unit it expected.
     */
    unit: referenceUnit('unit').notNull(),

    /** Where the figure came from. Shown next to it wherever it appears, per the spec. */
    sourceUrl: text('source_url').notNull(),

    /** When the figure was read from that source. Null for a placeholder nobody has filled in. */
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }),

    /**
     * When a human checked this figure against its source and approved it. **Null blocks every
     * read.**
     *
     * The gate, and the reason placeholders are safe to ship. A row with this null is scaffolding:
     * it names a figure that is needed, points at where to find it, and refuses to be used.
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    /** Who approved it, for the audit trail. Free text — this is an operator action, not a login. */
    verifiedBy: text('verified_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One figure per key per year. Two would make "the limit" ambiguous with no way to resolve it. */
    unique('contribution_limits_year_key_uq').on(table.taxYear, table.key),
  ],
)
