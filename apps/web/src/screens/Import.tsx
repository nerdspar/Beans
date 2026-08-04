import { COLUMN_ROLES, IMPORT_COPY, IMPORT_PRESETS } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { listManagedAccounts } from '../accounts/api.js'
import {
  commitImport,
  inspectCsv,
  previewImport,
  reverseImport,
  stageImport,
  type Inspection,
} from '../import/api.js'
import { cn } from '../lib/cn.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'

/**
 * Bringing history in from another app.
 *
 * Four steps, and the order is the point: **nothing reaches `transactions` until the rows have been
 * looked at**. A wrong amount column does not announce itself — it produces a plausible total — so
 * the mapping is shown with sample values, and the preview is read from staged rows rather than from
 * anything that has been committed. Reversal exists for the mistake found later still.
 */

type Stage =
  | { kind: 'choose' }
  | { kind: 'map'; content: string; filename: string; inspection: Inspection }
  | { kind: 'preview'; importId: string }
  | { kind: 'done'; importId: string; summary: string }

export function Import(): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'choose' })
  const [presetId, setPresetId] = useState('empower')
  const [accountId, setAccountId] = useState('')
  const [mapping, setMapping] = useState<Array<{ columnIndex: number; role: string }>>([])
  const queryClient = useQueryClient()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listManagedAccounts })

  const inspect = useMutation({
    mutationFn: async (file: File) => {
      const content = await file.text()
      return { content, filename: file.name, inspection: await inspectCsv(content) }
    },
    onSuccess: (result) => {
      setMapping(result.inspection.mapping)
      setStage({ kind: 'map', ...result })
    },
  })

  const stageRows = useMutation({
    mutationFn: (input: { content: string; filename: string }) =>
      stageImport({
        content: input.content,
        presetId,
        kind: 'transactions',
        targetAccountId: accountId,
        originalFilename: input.filename,
        mapping,
      }),
    onSuccess: (result) => setStage({ kind: 'preview', importId: result.importId }),
  })

  const preview = useQuery({
    queryKey: ['import-preview', stage.kind === 'preview' ? stage.importId : null],
    queryFn: () => previewImport((stage as { importId: string }).importId),
    enabled: stage.kind === 'preview',
  })

  const refreshWorkingSet = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  const commit = useMutation({
    mutationFn: () => commitImport((stage as { importId: string }).importId),
    onSuccess: async (result) => {
      await refreshWorkingSet()
      setStage({
        kind: 'done',
        importId: (stage as { importId: string }).importId,
        summary: IMPORT_COPY.committed(result.committed) + IMPORT_COPY.skipped(result.skipped),
      })
    },
  })

  const reverse = useMutation({
    mutationFn: () => reverseImport((stage as { importId: string }).importId),
    onSuccess: async (result) => {
      await refreshWorkingSet()
      setStage({
        kind: 'done',
        importId: (stage as { importId: string }).importId,
        summary: IMPORT_COPY.reversed(result.reversed),
      })
    },
  })

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-5">
      <h1 className="text-2xl font-semibold">{IMPORT_COPY.title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{IMPORT_COPY.blurb}</p>

      {stage.kind === 'choose' && (
        <div className="mt-5">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
            {IMPORT_COPY.chooseFile}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file !== undefined) inspect.mutate(file)
              }}
              className="mt-1 block w-full text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-sky-600 file:px-4 file:text-sm file:font-semibold file:text-white"
            />
          </label>
          <Problem error={inspect.error} fallback={IMPORT_COPY.readFailed} />
        </div>
      )}

      {stage.kind === 'map' && (
        <div className="mt-5">
          <Field label={IMPORT_COPY.account} help={IMPORT_COPY.accountHelp}>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className={selectClass}
            >
              <option value="">—</option>
              {(accounts.data ?? [])
                .filter((account) => !account.isClosed)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.institutionName ?? ''} {account.name}
                  </option>
                ))}
            </select>
          </Field>

          <Field label={IMPORT_COPY.source} help={IMPORT_COPY.sourceHelp}>
            <select
              value={presetId}
              onChange={(event) => setPresetId(event.target.value)}
              className={selectClass}
            >
              {IMPORT_PRESETS.filter((preset) => preset.kind === 'transactions').map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </Field>

          <h2 className="mt-5 text-sm font-semibold">{IMPORT_COPY.mapping}</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {IMPORT_COPY.mappingHelp}
          </p>

          <ul className="mt-2 space-y-2">
            {stage.inspection.headers.map((header, index) => (
              <li
                key={`${header}-${index}`}
                className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">{header}</span>
                  <select
                    value={mapping.find((m) => m.columnIndex === index)?.role ?? ''}
                    onChange={(event) =>
                      setMapping((current) => {
                        const without = current.filter((m) => m.columnIndex !== index)
                        return event.target.value === ''
                          ? without
                          : [...without, { columnIndex: index, role: event.target.value }]
                      })
                    }
                    className={cn(selectClass, 'w-40 shrink-0')}
                  >
                    <option value="">{IMPORT_COPY.ignore}</option>
                    {COLUMN_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>
                {/* The values, not just the header — this is what catches an all-positive column. */}
                <p className="mt-1 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                  {(stage.inspection.samples[index] ?? []).join(' · ') || '—'}
                </p>
              </li>
            ))}
          </ul>

          <Problem error={stageRows.error} fallback={IMPORT_COPY.stageFailed} />

          <button
            type="button"
            disabled={accountId === '' || mapping.length === 0 || stageRows.isPending}
            onClick={() => stageRows.mutate({ content: stage.content, filename: stage.filename })}
            className={primaryClass}
          >
            {stageRows.isPending ? IMPORT_COPY.staging : IMPORT_COPY.stage}
          </button>
        </div>
      )}

      {stage.kind === 'preview' && (
        <div className="mt-5">
          <h2 className="text-sm font-semibold">{IMPORT_COPY.previewHeading}</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {IMPORT_COPY.previewBlurb}
          </p>

          {/* An empty list and a failed request look identical otherwise. */}
          <Problem error={preview.error} fallback={IMPORT_COPY.stageFailed} />

          {preview.data !== undefined && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {IMPORT_COPY.rowsParsed(
                preview.data.totalRows - preview.data.failedRows,
                preview.data.totalRows,
              )}
            </p>
          )}

          <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
            {(preview.data?.rows ?? []).map((row) => (
              <li key={row.rowNumber} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">{row.description ?? '—'}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{row.date ?? '—'}</p>
                </div>
                <span
                  className={cn(
                    'shrink-0 text-sm tabular-nums',
                    row.error !== null && 'text-rose-600 dark:text-rose-400',
                  )}
                >
                  {row.error ?? row.amount ?? '—'}
                </span>
              </li>
            ))}
          </ul>

          <Problem error={commit.error} fallback={IMPORT_COPY.commitFailed} />

          <button
            type="button"
            disabled={commit.isPending}
            onClick={() => commit.mutate()}
            className={primaryClass}
          >
            {commit.isPending ? IMPORT_COPY.committing : IMPORT_COPY.commit}
          </button>
        </div>
      )}

      {stage.kind === 'done' && (
        <div className="mt-5">
          <p
            role="status"
            className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            {stage.summary}
          </p>

          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {IMPORT_COPY.reverseNote}
          </p>
          <Problem error={reverse.error} fallback={IMPORT_COPY.commitFailed} />

          <div className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={() => setStage({ kind: 'choose' })}
              className="min-h-12 flex-1 rounded-xl border border-slate-300 text-sm font-semibold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {IMPORT_COPY.startOver}
            </button>
            <button
              type="button"
              disabled={reverse.isPending}
              onClick={() => reverse.mutate()}
              className="min-h-12 flex-1 rounded-xl border border-rose-300 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
            >
              {reverse.isPending ? IMPORT_COPY.reversing : IMPORT_COPY.reverse}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const selectClass = cn(
  'mt-1 min-h-11 rounded-lg border px-3 text-sm',
  'border-slate-300 bg-white text-slate-900',
  'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
  'focus-visible:outline-2 focus-visible:outline-sky-500',
)

const primaryClass = cn(
  'mt-3 min-h-12 w-full rounded-xl text-sm font-semibold',
  'bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
)

function Field({
  label,
  help,
  children,
}: {
  label: string
  help: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="mt-4 block text-xs font-medium text-slate-600 dark:text-slate-400">
      {label}
      {children}
      <span className="mt-1 block font-normal">{help}</span>
    </label>
  )
}

/**
 * The server's message when it has one.
 *
 * A rejected file should say why — "row 14: could not read a date" is actionable where "import
 * failed" is not — so the fallback is only for an error that arrived without words.
 */
function Problem({ error, fallback }: { error: unknown; fallback: string }): ReactNode {
  const message = error instanceof Error ? error.message.trim() || fallback : null

  return (
    <p role="alert" className="mt-2 min-h-4 text-xs text-rose-600 dark:text-rose-400">
      {message}
    </p>
  )
}
