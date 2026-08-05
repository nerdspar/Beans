/** CSV import. Mirrors `apps/api/src/routes/imports.ts`. */

export type Inspection = {
  headers: string[]
  rowCount: number
  delimiter: string
  mapping: Array<{ columnIndex: number; role: string }>
  samples: string[][]
  /** Per column: its distinct values, or null when there are too many to be categorical. */
  distinct: Array<string[] | null>
}

export type StageResult = {
  importId: string
  rowCount: number
  parsedCount: number
  /** Rows whose own contents could not be read — a mapping or date-format problem. */
  unparsedCount: number
  /** Rows that parsed cleanly but named an account nothing is mapped to. A different fix entirely. */
  unroutedCount: number
}

export type PreviewRow = {
  rowNumber: number
  date: string | null
  description: string | null
  amount: string | null
  error: string | null
}

export type Preview = {
  rows: PreviewRow[]
  totalRows: number
  failedRows: number
  /** Every failure reason with a count, over the whole file rather than the previewed rows. */
  reasons: Array<{ reason: string; count: number }>
}

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
  /** Omitted when `accountMap` carries the routing instead. */
  targetAccountId?: string
  /** Maps each account named in the file to a Beans account. */
  accountMap?: Array<{ value: string; accountId: string }>
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

export type ImportProgress = {
  phase: 'reading' | 'committing'
  done: number
  total: number
}

/** Null when nothing is running. Polled only while a stage or commit is in flight. */
export function readImportProgress(): Promise<{ progress: ImportProgress | null }> {
  return send<{ progress: ImportProgress | null }>('/api/imports/progress')
}
