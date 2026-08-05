import {
  DEFAULT_CATEGORIES,
  categoryForTransaction,
  inRuleOrder,
  type CategoryRule,
  type KeywordMode,
  type RuleMatchType,
} from '@beans/shared'
import type { HouseholdContext } from './household-context.js'

/**
 * Categories and the rules that assign them.
 *
 * Matching itself lives in `@beans/shared` as a pure function; this is the part that needs a
 * database — reading rules, decrypting what they match on, and writing the result back.
 */

export class CategoryError extends Error {
  override readonly name = 'CategoryError'
}

export type Category = {
  id: string
  slug: string
  name: string
  kind: 'income' | 'expense' | 'transfer'
  parentId: string | null
  isSystem: boolean
}

/**
 * Installs the default set, once.
 *
 * Idempotent on slug, so running it against a household that already has categories adds only what
 * is genuinely missing — which is what makes it safe to call on every sign-in rather than requiring
 * a migration to backfill households created before it existed.
 */
export async function ensureDefaultCategories(context: HouseholdContext): Promise<{ added: number }> {
  const existing = await context.client.query<{ slug: string; id: string }>(
    'select slug, id from categories',
  )
  const bySlug = new Map(existing.rows.map((row) => [row.slug, row.id]))

  let added = 0

  // Parents first, so a child's parent id is always resolvable in the same pass.
  const ordered = [...DEFAULT_CATEGORIES].sort((left, right) =>
    left.parent === undefined ? -1 : right.parent === undefined ? 1 : 0,
  )

  for (const category of ordered) {
    if (bySlug.has(category.slug)) continue

    const parentId = category.parent === undefined ? null : (bySlug.get(category.parent) ?? null)

    const inserted = await context.client.query<{ id: string }>(
      `insert into categories (household_id, slug, name, kind, parent_id, is_system)
       values ($1, $2, $3, $4, $5, true)
       on conflict (household_id, slug) do nothing
       returning id`,
      [context.householdId, category.slug, category.name, category.kind, parentId],
    )

    const id = inserted.rows[0]?.id
    if (id !== undefined) {
      bySlug.set(category.slug, id)
      added += 1
    }
  }

  return { added }
}

export async function listCategories(context: HouseholdContext): Promise<Category[]> {
  const result = await context.client.query<{
    id: string
    slug: string
    name: string
    kind: Category['kind']
    parent_id: string | null
    is_system: boolean
  }>('select id, slug, name, kind, parent_id, is_system from categories order by name')

  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    parentId: row.parent_id,
    isSystem: row.is_system,
  }))
}

/**
 * Adds a category, optionally beneath a parent.
 *
 * The two-level limit is enforced here as well as by the trigger. The trigger is the guarantee; this
 * is what turns it into a sentence somebody can act on rather than a constraint violation.
 *
 * The slug is derived from the name and made unique, because rules and import presets reference
 * slugs rather than labels — so a category renamed later keeps working.
 */
export async function createCategory(
  context: HouseholdContext,
  input: { name: string; kind: Category['kind']; parentId: string | null },
): Promise<{ categoryId: string }> {
  const name = input.name.trim()
  if (name === '') throw new CategoryError('A category needs a name')

  let kind = input.kind

  if (input.parentId !== null) {
    const parent = await loadCategory(context, input.parentId)
    if (parent === null) throw new CategoryError('That parent category no longer exists')

    if (parent.parentId !== null) {
      throw new CategoryError(
        'Categories go two levels deep. Pick a top-level category as the parent.',
      )
    }

    /*
     * A child always takes its parent's kind.
     *
     * A "Groceries" expense sitting under "Income" would break every rollup that sums by kind, and
     * there is no reading of it that is useful — so it is not offered as a choice.
     */
    kind = parent.kind
  }

  const slug = await uniqueSlug(context, name)

  try {
    const result = await context.client.query<{ id: string }>(
      `insert into categories (household_id, slug, name, kind, parent_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [context.householdId, slug, name, kind, input.parentId],
    )

    const categoryId = result.rows[0]?.id
    if (categoryId === undefined) throw new CategoryError('Could not create the category')
    return { categoryId }
  } catch (error) {
    throw asFriendlyCategoryError(error, name)
  }
}

/**
 * Renames a category, or moves it under a different parent.
 *
 * **A system category's slug is immutable and its name is not.** The slug is what rules and presets
 * reference; the label is the user's to choose. Renaming "Groceries" to "Food" is theirs to make.
 */
export async function updateCategory(
  context: HouseholdContext,
  categoryId: string,
  patch: { name?: string | undefined; parentId?: string | null | undefined },
): Promise<void> {
  const category = await loadCategory(context, categoryId)
  if (category === null) throw new CategoryError('That category no longer exists')

  const name = patch.name === undefined ? category.name : patch.name.trim()
  if (name === '') throw new CategoryError('A category needs a name')

  let parentId = patch.parentId === undefined ? category.parentId : patch.parentId
  let kind = category.kind

  if (parentId !== null) {
    if (parentId === categoryId) throw new CategoryError('A category cannot sit inside itself')

    const parent = await loadCategory(context, parentId)
    if (parent === null) throw new CategoryError('That parent category no longer exists')
    if (parent.parentId !== null) {
      throw new CategoryError(
        'Categories go two levels deep. Pick a top-level category as the parent.',
      )
    }

    /*
     * Moving a category that has children of its own would put those children three deep. Refused
     * here with an explanation rather than left to the trigger, which can only say "violates".
     */
    const children = await context.client.query<{ count: string }>(
      'select count(*) as count from categories where parent_id = $1',
      [categoryId],
    )
    if (Number(children.rows[0]?.count ?? 0) > 0) {
      throw new CategoryError('Move or remove this category’s subcategories before nesting it.')
    }

    kind = parent.kind
  }

  try {
    const result = await context.client.query(
      'update categories set name = $2, parent_id = $3, kind = $4 where id = $1',
      [categoryId, name, parentId, kind],
    )
    if (result.rowCount === 0) throw new CategoryError('That category no longer exists')
  } catch (error) {
    throw asFriendlyCategoryError(error, name)
  }
}

/**
 * Removes a category, moving anything that used it somewhere else first.
 *
 * **Never silently discards categorization.** Transactions and rules pointing at it are reassigned
 * to `reassignTo`, or left uncategorized when that is null — stated either way, because "deleted"
 * quietly meaning "and un-categorized four hundred transactions" is the kind of thing somebody
 * discovers a month later in a cash flow chart.
 *
 * **Built-ins are removable too.** They were not, on the theory that transfer exclusion depended on
 * the "Transfers" category surviving. It does not: exclusion keys on a category's `kind`, not on any
 * slug (`isExcludedFromCashFlow`), so any transfer-kind category serves, and confirmed transfer
 * pairs are excluded by transaction id regardless. A default nobody uses is clutter in every picker
 * on every screen, and the set shipped can only ever be a guess at one household's spending.
 */
export async function deleteCategory(
  context: HouseholdContext,
  categoryId: string,
  reassignTo: string | null,
): Promise<{ transactionsMoved: number; rulesMoved: number }> {
  const category = await loadCategory(context, categoryId)
  if (category === null) throw new CategoryError('That category no longer exists')
  if (reassignTo === categoryId) throw new CategoryError('Pick a different category to move these to')

  const children = await context.client.query<{ count: string }>(
    'select count(*) as count from categories where parent_id = $1',
    [categoryId],
  )
  if (Number(children.rows[0]?.count ?? 0) > 0) {
    throw new CategoryError('Remove this category’s subcategories first.')
  }

  const moved = await context.client.query(
    'update transactions set category_id = $2 where category_id = $1',
    [categoryId, reassignTo],
  )

  /*
   * Rules cannot be left pointing at nothing — `category_id` is NOT NULL — so a rule whose category
   * is going away is deleted when there is nowhere to move it. Reported, so it is not a surprise.
   */
  let rulesMoved = 0
  if (reassignTo === null) {
    const removed = await context.client.query(
      'delete from category_rules where category_id = $1',
      [categoryId],
    )
    rulesMoved = removed.rowCount ?? 0
  } else {
    const reassigned = await context.client.query(
      'update category_rules set category_id = $2 where category_id = $1',
      [categoryId, reassignTo],
    )
    rulesMoved = reassigned.rowCount ?? 0
  }

  await context.client.query('delete from categories where id = $1', [categoryId])

  return { transactionsMoved: moved.rowCount ?? 0, rulesMoved }
}

async function loadCategory(
  context: HouseholdContext,
  categoryId: string,
): Promise<Category | null> {
  const result = await context.client.query<{
    id: string
    slug: string
    name: string
    kind: Category['kind']
    parent_id: string | null
    is_system: boolean
  }>(
    'select id, slug, name, kind, parent_id, is_system from categories where id = $1',
    [categoryId],
  )

  const row = result.rows[0]
  if (row === undefined) return null

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    parentId: row.parent_id,
    isSystem: row.is_system,
  }
}

/**
 * A slug from a name, with a numeric suffix when taken.
 *
 * Slugs are the stable reference; two categories called "Other" under different parents are legal
 * and must not collide here.
 */
async function uniqueSlug(context: HouseholdContext, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'category'

  const taken = await context.client.query<{ slug: string }>(
    'select slug from categories where slug = $1 or slug like $2',
    [base, `${base}-%`],
  )

  const used = new Set(taken.rows.map((row) => row.slug))
  if (!used.has(base)) return base

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }

  throw new CategoryError('Could not find a free name for that category')
}

/** Turns the unique-name constraint into something worth reading. */
function asFriendlyCategoryError(error: unknown, name: string): unknown {
  const code = (error as { code?: string } | null)?.code
  if (code === '23505') {
    return new CategoryError(`There is already a category called “${name}” in that place.`)
  }
  return error
}

/** Sets or clears one transaction's category. A user's answer, never overwritten by a rule later. */
export async function setTransactionCategory(
  context: HouseholdContext,
  transactionId: string,
  categoryId: string | null,
): Promise<void> {
  const result = await context.client.query(
    'update transactions set category_id = $2 where id = $1',
    [transactionId, categoryId],
  )

  if (result.rowCount === 0) {
    throw new CategoryError('No such transaction')
  }
}

export type RuleInput = {
  keywords: readonly string[]
  keywordMode: KeywordMode
  matchType: RuleMatchType
  matchAccountId: string | null
  categoryId: string
  priority?: number | undefined
}

export async function createRule(
  context: HouseholdContext,
  input: RuleInput,
): Promise<{ ruleId: string }> {
  const keywords = cleanKeywords(input.keywords)

  const result = await context.client.query<{ id: string }>(
    `insert into category_rules
       (household_id, priority, match_keywords, keyword_mode, match_type,
        match_account_id, category_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      context.householdId,
      input.priority ?? 0,
      keywords.length === 0 ? null : context.cipher.encryptJson(keywords),
      input.keywordMode,
      input.matchType,
      input.matchAccountId,
      input.categoryId,
    ],
  )

  const ruleId = result.rows[0]?.id
  if (ruleId === undefined) throw new CategoryError('Could not create the rule')
  return { ruleId }
}

/** Replaces a rule's conditions in place, so its position in the order survives an edit. */
export async function updateRule(
  context: HouseholdContext,
  ruleId: string,
  input: RuleInput,
): Promise<void> {
  const keywords = cleanKeywords(input.keywords)

  const result = await context.client.query(
    `update category_rules
        set match_keywords = $1,
            keyword_mode = $2,
            match_type = $3,
            match_account_id = $4,
            category_id = $5,
            priority = $6,
            -- Cleared, not left behind. A rule written before keywords existed would otherwise keep
            -- matching on a term the editor never showed and the user cannot see.
            match_description = null
      where id = $7`,
    [
      keywords.length === 0 ? null : context.cipher.encryptJson(keywords),
      input.keywordMode,
      input.matchType,
      input.matchAccountId,
      input.categoryId,
      input.priority ?? 0,
      ruleId,
    ],
  )

  if (result.rowCount === 0) throw new CategoryError('That rule no longer exists')
}

/**
 * Trimmed, de-duplicated, and blanks dropped.
 *
 * A blank term would make an `any` rule match everything — see `ruleMatches`. Removing them at the
 * write edge means a half-finished edit cannot be saved into a catch-all.
 */
function cleanKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>()

  for (const keyword of keywords) {
    const trimmed = keyword.trim()
    if (trimmed !== '') seen.add(trimmed)
  }

  return [...seen]
}

export async function deleteRule(context: HouseholdContext, ruleId: string): Promise<void> {
  await context.client.query('delete from category_rules where id = $1', [ruleId])
}

export type StoredRule = CategoryRule & { createdAt: string; categoryName: string }

export async function listRules(context: HouseholdContext): Promise<StoredRule[]> {
  const result = await context.client.query<{
    id: string
    priority: number
    enabled: boolean
    match_description: Buffer | null
    match_keywords: Buffer | null
    keyword_mode: KeywordMode
    match_type: RuleMatchType
    match_amount_min: Buffer | null
    match_amount_max: Buffer | null
    match_account_id: string | null
    category_id: string
    category_name: string
    created_at: Date
  }>(
    `select r.id, r.priority, r.enabled, r.match_description, r.match_keywords,
            r.keyword_mode, r.match_type,
            r.match_amount_min, r.match_amount_max, r.match_account_id,
            r.category_id, c.name as category_name, r.created_at
       from category_rules r
       join categories c on c.id = r.category_id`,
  )

  return inRuleOrder(
    result.rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      enabled: row.enabled,
      /*
       * Legacy single-term rules are folded in on read.
       *
       * The old column is encrypted, so no SQL migration could move it into the array — the
       * database cannot read it to transform it (ARCHITECTURE.md §3.1). Nothing writes it any more,
       * and editing a rule clears it, so this path empties out on its own.
       */
      keywords:
        row.match_keywords !== null
          ? context.cipher.decryptJson<string[]>(row.match_keywords)
          : row.match_description !== null
            ? [context.cipher.decryptText(row.match_description)]
            : [],
      keywordMode: row.keyword_mode,
      matchType: row.match_type,
      matchAmountMin:
        row.match_amount_min === null ? null : context.cipher.decryptMoney(row.match_amount_min),
      matchAmountMax:
        row.match_amount_max === null ? null : context.cipher.decryptMoney(row.match_amount_max),
      matchAccountId: row.match_account_id,
      categoryId: row.category_id,
      categoryName: row.category_name,
      createdAt: row.created_at.toISOString(),
    })),
  )
}

/**
 * Applies every rule to transactions that have no category yet.
 *
 * **Only uncategorized ones.** A rule must never overwrite an answer a person gave — they looked at
 * that transaction and decided, and having a rule silently undo it later is the behaviour that makes
 * people stop trusting automatic categorization entirely. Recategorizing deliberately is a separate
 * action, not a side effect of adding a rule.
 */
export async function applyRules(context: HouseholdContext): Promise<{ categorized: number }> {
  const rules = await listRules(context)
  if (rules.length === 0) return { categorized: 0 }

  const transactions = await context.client.query<{
    id: string
    account_id: string
    amount: Buffer
    description: Buffer | null
    payee: Buffer | null
  }>(
    `select id, account_id, amount, description, payee
       from transactions
      where category_id is null and status = 'active'`,
  )

  let categorized = 0

  for (const row of transactions.rows) {
    const categoryId = categoryForTransaction(rules, {
      accountId: row.account_id,
      amountCents: context.cipher.decryptMoney(row.amount),
      description: row.description === null ? null : context.cipher.decryptText(row.description),
      payee: row.payee === null ? null : context.cipher.decryptText(row.payee),
    })

    if (categoryId === null) continue

    await context.client.query('update transactions set category_id = $2 where id = $1', [
      row.id,
      categoryId,
    ])
    categorized += 1
  }

  return { categorized }
}
