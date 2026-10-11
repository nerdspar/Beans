import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts.js'
import { authUser } from './auth.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { recurringDecision } from './enums.js'
import { households } from './tenancy.js'

/**
 * What the household has said about a recurring series (ARCHITECTURE.md §20).
 *
 * Detection runs in the browser and stores nothing; this is the only server state the feature has.
 * A row exists only where a person overrode the detector — moved a subscription to bills, or hid a
 * series that is not recurring at all. Hiding is **sticky** for the same reason a rejected transfer
 * is (§9): a prompt that comes back after every sync is a prompt people stop reading.
 */
export const recurringDecisions = pgTable(
  'recurring_decisions',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /**
     * The series' merchant key, encrypted. It is derived from payee text — a list of these is a list
     * of who the household pays — so it gets the same treatment as a rule's match text.
     *
     * Encrypted means no unique constraint: the ciphertext of one key differs on every write. The
     * repository serializes writes per household and matches keys after decrypting instead.
     */
    merchantKey: bytea('merchant_key').notNull(),

    decision: recurringDecision('decision').notNull(),

    /**
     * The account the series last charged. Not used for matching — it is what makes the row
     * **visible only to people who can see that account**.
     *
     * Without it, a member hiding a charge on their private account would send its merchant name to
     * everybody else in the household in the next working set (§6.4). Reads inner-join `accounts`,
     * so account visibility decides which decisions come back, with no second copy of that rule.
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    decidedByUserId: text('decided_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('recurring_decisions_household_updated_at_idx').on(table.householdId, table.updatedAt),
    index('recurring_decisions_account_idx').on(table.accountId),
    householdIsolationPolicy('recurring_decisions'),
  ],
).enableRLS()
