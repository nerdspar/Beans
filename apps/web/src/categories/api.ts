/** Categories and rules. Mirrors `apps/api/src/routes/categories.ts`. */

export type Category = {
  id: string
  slug: string
  name: string
  kind: 'income' | 'expense' | 'transfer'
  parentId: string | null
  isSystem: boolean
}

export type Rule = {
  id: string
  priority: number
  enabled: boolean
  matchDescription: string | null
  matchType: 'contains' | 'regex'
  matchAccountId: string | null
  categoryId: string
  categoryName: string
  createdAt: string
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

export function createRule(input: {
  matchDescription: string
  matchType: 'contains' | 'regex'
  categoryId: string
}): Promise<{ ruleId: string; categorized: number }> {
  return send('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function deleteRule(id: string): Promise<void> {
  return send(`/api/rules/${id}`, { method: 'DELETE' })
}

export function applyRules(): Promise<{ categorized: number }> {
  return send('/api/rules/apply', { method: 'POST' })
}
