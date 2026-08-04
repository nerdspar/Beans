/** CSV import. Mirrors `apps/api/src/routes/imports.ts`. */

export type Inspection = {
  headers: string[]
  rowCount: number
  delimiter: string
  mapping: Array<{ columnIndex: number; role: string }>
  samples: string[][]
}

export type StageResult = { importId: string; rowCount: number; parsedCount: number }

export type PreviewRow = {
  rowNumber: number
  date: string | null
  description: string | null
  amount: string | null
  error: string | null
}

export type Preview = { rows: PreviewRow[]; totalRows: number; failedRows: number }

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export function inspectCsv(content: string): Promise<Inspection> {
  return send('/api/imports/inspect', json({ content }))
}

export function stageImport(input: {
  content: string
  presetId: string
  kind: 'transactions' | 'balances'
  targetAccountId: string
  originalFilename: string
  mapping: Array<{ columnIndex: number; role: string }>
}): Promise<StageResult> {
  return send('/api/imports', json(input))
}

export function previewImport(importId: string): Promise<Preview> {
  return send(`/api/imports/${importId}/preview`)
}

export function commitImport(importId: string): Promise<{ committed: number; skipped: number }> {
  return send(`/api/imports/${importId}/commit`, { method: 'POST' })
}

export function reverseImport(importId: string): Promise<{ reversed: number }> {
  return send(`/api/imports/${importId}/reverse`, { method: 'POST' })
}
