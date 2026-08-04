/**
 * The category set every household starts with.
 *
 * Editable afterwards — renameable, extendable, and children can be added under any parent. What
 * cannot change is a **slug**, because rules and CSV import presets reference slugs rather than
 * display labels. Renaming "Groceries" to "Food" must break nothing.
 *
 * Two levels, no more (ARCHITECTURE.md §8). Deep trees look tidy in a settings screen and then every
 * report has to decide how to roll them up.
 */

export type CategoryKind = 'income' | 'expense' | 'transfer'

export type DefaultCategory = {
  slug: string
  name: string
  kind: CategoryKind
  /** Slug of the parent, for the second level. */
  parent?: string
}

/**
 * `transfer` is one category and it is load-bearing.
 *
 * Cash flow excludes a transaction whose category kind is `transfer` (§9). That covers money sent to
 * an account Beans does not track, which has no counterpart to pair with and would otherwise read as
 * spending forever. Removing this category would quietly break that path.
 */
export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { slug: 'income', name: 'Income', kind: 'income' },
  { slug: 'income-salary', name: 'Salary', kind: 'income', parent: 'income' },
  { slug: 'income-interest', name: 'Interest', kind: 'income', parent: 'income' },
  { slug: 'income-other', name: 'Other income', kind: 'income', parent: 'income' },

  { slug: 'housing', name: 'Housing', kind: 'expense' },
  { slug: 'housing-mortgage-rent', name: 'Mortgage & rent', kind: 'expense', parent: 'housing' },
  { slug: 'housing-utilities', name: 'Utilities', kind: 'expense', parent: 'housing' },
  { slug: 'housing-maintenance', name: 'Maintenance', kind: 'expense', parent: 'housing' },

  { slug: 'food', name: 'Food', kind: 'expense' },
  { slug: 'food-groceries', name: 'Groceries', kind: 'expense', parent: 'food' },
  { slug: 'food-dining', name: 'Restaurants', kind: 'expense', parent: 'food' },

  { slug: 'transport', name: 'Transport', kind: 'expense' },
  { slug: 'transport-fuel', name: 'Fuel', kind: 'expense', parent: 'transport' },
  { slug: 'transport-vehicle', name: 'Vehicle', kind: 'expense', parent: 'transport' },
  { slug: 'transport-transit', name: 'Transit & parking', kind: 'expense', parent: 'transport' },

  { slug: 'health', name: 'Health', kind: 'expense' },
  { slug: 'shopping', name: 'Shopping', kind: 'expense' },
  { slug: 'entertainment', name: 'Entertainment', kind: 'expense' },
  { slug: 'subscriptions', name: 'Subscriptions', kind: 'expense' },
  { slug: 'travel', name: 'Travel', kind: 'expense' },
  { slug: 'insurance', name: 'Insurance', kind: 'expense' },
  { slug: 'taxes', name: 'Taxes', kind: 'expense' },
  { slug: 'fees', name: 'Fees & interest', kind: 'expense' },
  { slug: 'expense-other', name: 'Other', kind: 'expense' },

  { slug: 'transfers', name: 'Transfers', kind: 'transfer' },
]

/** The slug cash flow relies on for the category half of its exclusion rule. */
export const TRANSFER_CATEGORY_SLUG = 'transfers'
