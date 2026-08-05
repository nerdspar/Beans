import type { KeywordMode } from '@beans/shared'

/** Categories and rules. Mirrors `apps/api/src/routes/categories.ts`. */

export type CategoryKind = 'income' | 'expense' | 'transfer'

export type Category = {
  id: string
  slug: string
  name: string
  kind: CategoryKind
  parentId: string | null
  isSystem: boolean
}

export type Rule = {
  id: string
  priority: number
  enabled: boolean
  /** The terms this rule looks for. Legacy single-term rules arrive as a one-element list. */
  keywords: string[]
  keywordMode: KeywordMode
  matchType: 'contains' | 'regex'
  matchAccountId: string | null
  categoryId: string
  categoryName: string
  createdAt: string
}

export type RuleInput = {
  keywords: string[]
  keywordMode: KeywordMode
  matchType: 'contains' | 'regex'
  categoryId: string
  matchAccountId?: string | null
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export function listCategories(): Promise<Category[]> {
  return send<{ categories: Category[] }>('/api/categories').then((b) => b.categories ?? [])
}

export function assignCategory(transactionId: string, categoryId: string | null): Promise<void> {
  return send(`/api/transactions/${transactionId}/category`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ categoryId }),
  })
}

export function listRules(): Promise<Rule[]> {
  return send<{ rules: Rule[] }>('/api/rules').then((b) => b.rules ?? [])
}

export function createRule(input: RuleInput): Promise<{ ruleId: string; categorized: number }> {
  return send('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** Editing keeps the rule's id, so its place in the order survives. */
export function updateRule(id: string, input: RuleInput): Promise<{ categorized: number }> {
  return send(`/api/rules/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function createCategory(input: {
  name: string
  kind: CategoryKind
  parentId: string | null
}): Promise<{ categoryId: string }> {
  return send('/api/categories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateCategory(
  id: string,
  patch: { name?: string; parentId?: string | null },
): Promise<void> {
  return send(`/api/categories/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * Removes a category and reports what moved.
 *
 * `reassignTo: null` leaves its transactions uncategorized — which is a real choice, so the counts
 * come back and the screen states them rather than saying "deleted".
 */
export function deleteCategory(
  id: string,
  reassignTo: string | null,
): Promise<{ transactionsMoved: number; rulesMoved: number }> {
  return send(`/api/categories/${id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reassignTo }),
  })
}

export function deleteRule(id: string): Promise<void> {
  return send(`/api/rules/${id}`, { method: 'DELETE' })
}

export function applyRules(): Promise<{ categorized: number }> {
  return send('/api/rules/apply', { method: 'POST' })
}
