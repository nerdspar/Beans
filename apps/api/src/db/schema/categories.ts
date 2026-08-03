import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import {
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { categoryKind } from './enums.js'
import { households } from './tenancy.js'

/**
 * Our own categorization. SimpleFIN provides none.
 *
 * Household-scoped and seeded with a default set each household can edit. Names are plaintext:
 * they are not sensitive, and filtering happens by `category_id` anyway.
 */
export const categories = pgTable(
  'categories',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /**
     * Stable identifier, **immutable for system categories**.
     *
     * Rules and CSV import presets reference the slug, never the display label, so renaming
     * "Groceries" to "Food" breaks nothing.
     */
    slug: text('slug').notNull(),

    /** Display label. Freely renameable. */
    name: text('name').notNull(),

    kind: categoryKind('kind').notNull(),

    /**
     * **Two levels maximum**: a category with a parent may not itself be a parent.
     *
     * This cannot be expressed as a `CHECK` — it requires looking at another row — so it is
     * enforced by a trigger *and* a repository invariant, with a test that nests three deep and
     * asserts failure. Unconstrained self-reference makes rollups ambiguous and forces every UI to
     * handle arbitrary depth, and it is unfixable once real data exists.
     *
     * `restrict` on delete: removing a parent that still has children should fail loudly rather
     * than silently orphaning or cascading away a user's categorized history.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'restrict',
    }),

    isSystem: boolean('is_system').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    archived: boolean('archived').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Scoped by parent so "Other" can exist under both Income and Expenses.
     *
     * `NULLS NOT DISTINCT` (PG15+) is load-bearing: Postgres treats NULLs as distinct in a unique
     * constraint by default, which would otherwise permit two *top-level* categories both named
     * "Other".
     */
    unique('categories_household_parent_name_uq')
      .on(table.householdId, table.parentId, table.name)
      .nullsNotDistinct(),

    /** The slug carries stable uniqueness, independent of the display label and of nesting. */
    unique('categories_household_slug_uq').on(table.householdId, table.slug),

    index('categories_household_idx').on(table.householdId),
    index('categories_parent_idx').on(table.parentId),
    householdIsolationPolicy('categories'),
  ],
).enableRLS()
