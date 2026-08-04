import {
  DEFAULT_CATEGORIES,
  categoryForTransaction,
  inRuleOrder,
  type CategoryRule,
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
  matchDescription: string | null
  matchType: RuleMatchType
  matchAccountId: string | null
  categoryId: string
  priority?: number | undefined
}

export async function createRule(
  context: HouseholdContext,
  input: RuleInput,
): Promise<{ ruleId: string }> {
  const result = await context.client.query<{ id: string }>(
    `insert into category_rules
       (household_id, priority, match_description, match_type, match_account_id, category_id)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      context.householdId,
      input.priority ?? 0,
      input.matchDescription === null ? null : context.cipher.encryptText(input.matchDescription),
      input.matchType,
      input.matchAccountId,
      input.categoryId,
    ],
  )

  const ruleId = result.rows[0]?.id
  if (ruleId === undefined) throw new CategoryError('Could not create the rule')
  return { ruleId }
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
    match_type: RuleMatchType
    match_amount_min: Buffer | null
    match_amount_max: Buffer | null
    match_account_id: string | null
    category_id: string
    category_name: string
    created_at: Date
  }>(
    `select r.id, r.priority, r.enabled, r.match_description, r.match_type,
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
      matchDescription:
        row.match_description === null ? null : context.cipher.decryptText(row.match_description),
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
