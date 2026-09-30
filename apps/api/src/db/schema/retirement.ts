import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { TaxTreatment } from '@beans/shared'
import { accounts } from './accounts.js'
import { authUser } from './auth.js'
import { categories } from './categories.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { spendingTreatment, taxTreatment } from './enums.js'
import { households } from './tenancy.js'

/**
 * Retirement planning.
 *
 * Everything here is an **assumption or an answer**, never an observation. The observations live in
 * `accounts`, `transactions` and `balance_snapshots` and are untouched by any of this — the planner
 * reads them and writes nothing back. That separation is what lets a projection be rerun, argued
 * with, or thrown away without the household's actual financial record moving a cent.
 *
 * Three deliberate departures from the retirement spec, each because the codebase already answers
 * the question differently:
 *
 * 1. **No `dollars_basis` column.** The spec fixes it to `real`. A column with one legal value
 *    advertises a choice that does not exist, and the first person to see it will assume a nominal
 *    mode is implemented somewhere. Real dollars is a property of the engine, stated on screen
 *    beside every figure, and switching it later would be a code change regardless.
 * 2. **No `is_anchor` on `account_tax_buckets`.** Carry-forward is computed, not persisted
 *    (`packages/shared/src/retirement/buckets.ts`), so every row here is an anchor by construction.
 *    A column that is always true is a column that eventually gets written false by mistake.
 * 3. **No planning-horizon column on the profile.** `retirement_members.life_expectancy` already
 *    determines it, and two sources for one number is how they come to disagree.
 *
 * `opportunity_states` and `contribution_limits` are phase B and deliberately absent. Creating an
 * empty `contribution_limits` now would invite a seed written from memory, which is the one thing
 * the spec says does not bend.
 */

/**
 * One per household: the assumptions that apply across every scenario.
 *
 * What varies between scenarios lives on `retirement_scenarios`. What does not — the tax rate
 * assumption, the withdrawal order, the healthcare bridge — lives here, so changing it changes all
 * three bands together rather than being restated three times and drifting.
 */
export const retirementProfiles = pgTable(
  'retirement_profiles',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /**
     * Assumed effective tax rate in retirement, in basis points. 2200 is 22%.
     *
     * Feeds the after-tax equivalent and the projection's withdrawal tax estimate. **An assumption,
     * not a calculation**, and labelled as one everywhere it surfaces: Beans knows what is held and
     * roughly what is spent, and knows nothing about future brackets, future law, or which state
     * somebody will retire to.
     *
     * Basis points rather than a decimal because every rate in this codebase is basis points, and a
     * float here would round its way into the money path.
     */
    retirementEffectiveRateBasisPoints: integer('retirement_effective_rate_basis_points')
      .notNull()
      .default(2_200),

    /**
     * The order buckets are drawn down in. Null means the default: taxable, then pre-tax, then Roth.
     *
     * `jsonb`, matching `user_preferences.tab_order`, and read through a resolver that ignores
     * unknown keys rather than trusting the column — an ordering that silently contains a treatment
     * the code no longer knows would otherwise skip a bucket in a withdrawal loop.
     *
     * **`jsonb` needs `JSON.stringify` on the way in.** node-pg serializes a JS array as a Postgres
     * array literal (`{a,b,c}`), which `jsonb` rejects — the bug that made `tab_order` silently
     * refuse to save.
     */
    withdrawalOrder: jsonb('withdrawal_order').$type<TaxTreatment[] | null>(),

    /**
     * Annual out-of-pocket healthcare cost between retiring and turning 65, in cents.
     *
     * **Its own field rather than a line in the spending review**, because it is the single largest
     * unknown for anyone retiring early and averaging it into a category baseline produces a
     * cheerful, wrong projection. Null means nobody has been asked yet, which the wizard can tell
     * apart from an answer of zero.
     *
     * Modelling it properly — the bridge years, per member, against real plan costs — is phase D.
     * What this buys now is that the number is visible and enterable rather than silently absent.
     */
    pre65HealthcareAnnualAmount: bytea('pre65_healthcare_annual_amount'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One profile per household. A second would make "the plan" ambiguous with no way to resolve it. */
    unique('retirement_profiles_household_uq').on(table.householdId),
    householdIsolationPolicy('retirement_profiles'),
  ],
).enableRLS()

/**
 * A person in the plan.
 *
 * Separate from `household_members` on purpose: a spouse who never signs in is still someone who
 * retires on a date and claims Social Security on a schedule, and a plan that cannot represent them
 * is wrong for most households. `user_id` links the two when the person does happen to have an
 * account.
 *
 * **Modelled per person from the start**, rather than as a household aggregate with a second set of
 * fields bolted on later. Two people retire on different dates, claim at different ages, and reach
 * RMD age in different years; every one of those is a branch in the projection.
 */
export const retirementMembers = pgTable(
  'retirement_members',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => retirementProfiles.id, { onDelete: 'cascade' }),

    /** Encrypted: a person's name is personal data even with no amount beside it. */
    displayName: bytea('display_name').notNull(),

    /**
     * The Beans user this person is, when they are one. Null for a spouse who never signs in.
     *
     * `set null` rather than cascade: removing somebody's login must not delete them from the
     * household's retirement plan.
     */
    userId: text('user_id').references(() => authUser.id, { onDelete: 'set null' }),

    /**
     * Year only, not a birth date.
     *
     * Every age this feature cares about — catch-up tiers, Medicare at 65, the RMD age — is
     * evaluated per tax year, so the day and month never enter the arithmetic. Storing less is the
     * cheapest way to not leak more, and plaintext because nothing computed from it is sensitive
     * without the encrypted name beside it.
     */
    birthYear: integer('birth_year').notNull(),

    targetRetirementDate: date('target_retirement_date'),

    /** The age Social Security is claimed at. Claiming early or late changes the benefit materially. */
    socialSecurityClaimAge: integer('social_security_claim_age'),

    /**
     * The annual benefit, in cents, **as read off an SSA statement**.
     *
     * Never computed. The formula needs a full indexed wage history that Beans does not have and
     * cannot get, and an estimate produced from a year of transactions would be wrong by a margin
     * that swamps the rest of the projection. The wizard links to ssa.gov and asks.
     */
    socialSecurityAnnualBenefit: bytea('social_security_annual_benefit'),

    /**
     * Age the projection runs to for this person. Null falls back to the engine default.
     *
     * This is the planning horizon; there is no separate column for it. Running out of money at 95
     * and running out at 85 are different plans, and the age is the honest place to state the
     * assumption because it is the one the user can actually reason about.
     */
    lifeExpectancy: integer('life_expectancy'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('retirement_members_profile_idx').on(table.profileId),
    householdIsolationPolicy('retirement_members'),
  ],
).enableRLS()

/**
 * What happens to each spending category in retirement.
 *
 * Scoped to the profile rather than being a column on `categories`, which matters: a category is a
 * fact about how the household classifies money today, and what it does in retirement is an opinion
 * about the future. Putting the opinion on the fact would mean editing a category to revise a plan,
 * and would leave no room for a second plan to disagree.
 *
 * `reviewed_at` exists so the wizard can re-prompt when something material changes and stay quiet
 * otherwise. **Once a year at most** — a planner that nags gets dismissed, and a dismissed planner
 * reviews nothing at all.
 */
export const retirementSpendingAssumptions = pgTable(
  'retirement_spending_assumptions',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => retirementProfiles.id, { onDelete: 'cascade' }),

    /**
     * `restrict`, matching `categories.parent_id`. Deleting a category that a plan depends on
     * should fail loudly rather than quietly changing what the projection spends.
     */
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),

    treatment: spendingTreatment('treatment').notNull(),

    /**
     * For `adjusted`: what fraction of today's spending continues, in basis points. 7000 is 70%.
     *
     * Null for `continues` and `stops`, where it would be meaningless. The pairing is a repository
     * invariant rather than a `CHECK` so the error can say something useful, and because the honest
     * constraint — *this is required only for one enum value* — reads far better in code than in a
     * constraint name somebody meets at 2am.
     */
    adjustmentBasisPoints: integer('adjustment_basis_points'),

    /** When a human last looked at this row. Drives re-prompting; see the note above about nagging. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('retirement_spending_assumptions_profile_category_uq').on(
      table.profileId,
      table.categoryId,
    ),
    index('retirement_spending_assumptions_profile_idx').on(table.profileId),
    householdIsolationPolicy('retirement_spending_assumptions'),
  ],
).enableRLS()

/**
 * A named set of return assumptions. Seeded with three, all editable, and the user can add more.
 *
 * Three run **simultaneously and render as a band**, never as a line. A point estimate implies a
 * precision that does not exist, and the single most misleading thing a retirement tool does is
 * draw one confident curve through thirty years of unknown returns.
 *
 * Returns are **real** — net of inflation, in today's dollars — throughout. Nominal projections
 * produce headline numbers that feel wonderful and mean nothing.
 */
export const retirementScenarios = pgTable(
  'retirement_scenarios',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => retirementProfiles.id, { onDelete: 'cascade' }),

    /** Plaintext, like category names. "Expected" says nothing about anybody's finances. */
    name: text('name').notNull(),

    /**
     * Separate pre- and post-retirement returns, because most people de-risk on approach and a
     * single rate across both eras quietly assumes they do not.
     */
    preRetirementReturnBasisPoints: integer('pre_retirement_return_basis_points').notNull(),
    postRetirementReturnBasisPoints: integer('post_retirement_return_basis_points').notNull(),

    /** Optional override of the spending baseline the review produced, in cents. */
    annualSpendingOverride: bytea('annual_spending_override'),

    /**
     * Shifts every member's retirement date by this many years. Null leaves the dates alone.
     *
     * A shift rather than an absolute date, which the spec proposed: members retire on *different*
     * dates, so one date on the scenario would have to either overwrite both — collapsing the
     * distinction the members table exists to keep — or silently apply to one of them. "Retire two
     * years earlier" is also the question people actually ask.
     */
    retirementYearsOffset: integer('retirement_years_offset'),

    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('retirement_scenarios_profile_name_uq').on(table.profileId, table.name),

    /** At most one default per profile. Two would make "the headline number" a coin toss. */
    uniqueIndex('retirement_scenarios_profile_default_uq')
      .on(table.profileId)
      .where(sql`${table.isDefault}`),

    index('retirement_scenarios_profile_idx').on(table.profileId),
    householdIsolationPolicy('retirement_scenarios'),
  ],
).enableRLS()

/**
 * The tax split of one account, as the provider showed it on a date. Every row is an anchor.
 *
 * A single 401(k) commonly holds pre-tax, Roth and after-tax non-Roth money at once, and SimpleFIN
 * reports one balance for the whole account and will never break it out. So this is a user-
 * maintained overlay: they read the breakdown off their provider and enter it, and
 * `carryBucketsForward` models the split between anchors rather than storing a percentage.
 *
 * **A fixed percentage is wrong and will drift** — a frozen traditional balance beside a contributed
 * Roth balance changes ratio every year on its own. That is the reason this is dated rows rather
 * than a single breakdown per account.
 *
 * `accounts.tax_treatment` stays as the account-level fallback for the simple case, and stays
 * authoritative for every account nobody has broken out. Net worth, the account list and every
 * phase 1 view read the account balance and are unaffected by anything here.
 */
export const accountTaxBuckets = pgTable(
  'account_tax_buckets',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    treatment: taxTreatment('treatment').notNull(),

    /** In cents. Encrypted, like every other balance in the schema. */
    balance: bytea('balance').notNull(),

    /** The date the provider's figure was for, not the date it was typed in. */
    asOfDate: date('as_of_date').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * One figure per bucket per date. Re-entering a breakdown for a date already anchored replaces
     * it, because the later entry is the correction — two rows would make the anchor ambiguous and
     * the carry-forward would silently pick one.
     */
    unique('account_tax_buckets_account_treatment_date_uq').on(
      table.accountId,
      table.treatment,
      table.asOfDate,
    ),
    index('account_tax_buckets_account_date_idx').on(table.accountId, table.asOfDate),
    householdIsolationPolicy('account_tax_buckets'),
  ],
).enableRLS()

/**
 * Which bucket new contributions land in.
 *
 * Without this the carry-forward cannot do the one thing it exists for. Growth alone preserves a
 * ratio; only contributions move it, and they only move it if something says where they go.
 *
 * **An annual amount, not a percentage of salary.** The spec offered either, but Beans has no
 * salary figure to apply a percentage to — pay arrives as deposits, net of withholding, and a
 * 401(k) deferral never appears as a transaction at all. A percentage field would need a second
 * field for the salary it is a percentage of, which is a guess wearing two coats.
 */
export const accountContributionRouting = pgTable(
  'account_contribution_routing',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    treatment: taxTreatment('treatment').notNull(),

    /** Per year, in cents. The projection steps annually. */
    annualAmount: bytea('annual_amount').notNull(),

    /**
     * Whether contributions are still going in. Kept rather than deleted so that stopping and
     * restarting does not lose the amount, and so the wizard can show what was there before.
     */
    active: boolean('active').notNull().default(true),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('account_contribution_routing_account_treatment_uq').on(
      table.accountId,
      table.treatment,
    ),
    index('account_contribution_routing_account_idx').on(table.accountId),
    householdIsolationPolicy('account_contribution_routing'),
  ],
).enableRLS()

/**
 * What an employer plan actually permits. **User-answered, never inferred.**
 *
 * None of this is discoverable: it lives in a summary plan description, not in any API, and two
 * 401(k)s at the same recordkeeper routinely differ. The mega-backdoor rules in phase B are gated
 * on these answers precisely so the app never tells somebody a strategy is available when their
 * plan does not offer it.
 *
 * Every flag is a **nullable** boolean, and the null is load-bearing: *not asked* has to be
 * distinguishable from *asked, and no*. Defaulting them to false would make an unanswered plan look
 * like a restrictive one and quietly suppress a rule that might apply.
 */
export const planFeatures = pgTable(
  'plan_features',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    allowsAfterTaxContributions: boolean('allows_after_tax_contributions'),
    allowsInPlanRothConversion: boolean('allows_in_plan_roth_conversion'),
    allowsInServiceWithdrawal: boolean('allows_in_service_withdrawal'),

    /**
     * Whether the plan accepts roll-ins from an IRA.
     *
     * The remedy for a pro-rata conflict, and worth asking about on its own: rolling IRA balances
     * *into* an employer plan clears the pro-rata calculation, while the far more commonly given
     * advice — consolidating an old 401(k) into an IRA — creates one.
     */
    acceptsIraRollIns: boolean('accepts_ira_roll_ins'),

    /**
     * The match formula in the user's own words, encrypted.
     *
     * Free text rather than parsed fields because real formulas are tiered, capped, graded and
     * sometimes true-up annually, and a schema that models half of them would confidently
     * mis-evaluate the other half. Phase B reads it to show alongside the figure, not to compute
     * from. Encrypted because it describes someone's compensation.
     */
    employerMatchDescription: bytea('employer_match_description'),

    /** When these answers were given. An unanswered plan has this null and every flag null. */
    answeredAt: timestamp('answered_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('plan_features_account_uq').on(table.accountId),
    householdIsolationPolicy('plan_features'),
  ],
).enableRLS()

/**
 * Every projection that was ever run, kept. **Immutable** — hence `created_at` and no `updated_at`.
 *
 * This is the table that makes the plan answerable to itself: "a year ago the plan projected X for
 * today, and you are actually at Y." Nothing else in the category does that, and it costs one
 * table. A run that could be edited afterwards would make that comparison worthless, so rows are
 * written once and never touched.
 *
 * `inputs` and `results` are **`bytea`, not `jsonb`** — encrypted JSON. The spec asked for both at
 * once and they are mutually exclusive: an encrypted column cannot be queried, indexed or summed in
 * SQL (§3.1, §7), which is exactly the property that makes it safe. Everything needed to *find* a
 * run — the household, the time — is in the plaintext columns beside them.
 *
 * The snapshot is complete on purpose. A run that stored only results would be uninterpretable the
 * moment somebody edited an assumption, which is the same afternoon.
 */
export const projectionRuns = pgTable(
  'projection_runs',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => retirementProfiles.id, { onDelete: 'cascade' }),

    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),

    /** Encrypted JSON: every assumption that produced this run. */
    inputs: bytea('inputs').notNull(),

    /** Encrypted JSON: the summary figures, per scenario. */
    results: bytea('results').notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    index('projection_runs_household_run_at_idx').on(table.householdId, table.runAt),
    index('projection_runs_profile_run_at_idx').on(table.profileId, table.runAt),
    householdIsolationPolicy('projection_runs'),
  ],
).enableRLS()
