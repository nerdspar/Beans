import { ACCOUNT_TYPES, COLUMN_ROLES, IMPORT_COPY, IMPORT_PRESETS } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { createManualAccount, listManagedAccounts } from '../accounts/api.js'
import {
  commitImport,
  inspectCsv,
  previewImport,
  reverseImport,
  stageImport,
  type Inspection,
} from '../import/api.js'
import { cn } from '../lib/cn.js'
import { SearchableSelect } from '../lib/SearchableSelect.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'

/**
 * Bringing history in from another app.
 *
 * Four steps, and the order is the point: **nothing reaches `transactions` until the rows have been
 * looked at**. A wrong amount column does not announce itself — it produces a plausible total — so
 * the mapping is shown with sample values, and the preview is read from staged rows rather than from
 * anything that has been committed. Reversal exists for the mistake found later still.
 */

/**
 * Chosen in the account dropdown to mean "this one no longer exists, make it".
 *
 * Not an empty string, which means skip. The two look similar in a dropdown and are opposites:
 * skipping discards the rows, creating gives them somewhere to land.
 */
const CREATE_SENTINEL = '__create__'

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
  /**
   * Account name as it appears in the file → Beans account id.
   *
   * Empty string means skip. The sentinel below means "create it", which is a different thing:
   * skipping drops the rows, creating gives them somewhere to land.
   */
  const [accountMap, setAccountMap] = useState<Record<string, string>>({})

  /** Draft closed accounts, keyed by the name in the file, for the CREATE sentinel. */
  const [drafts, setDrafts] = useState<Record<string, { type: string; closedOn: string }>>({})
  const queryClient = useQueryClient()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listManagedAccounts })
  const openAccounts = (accounts.data ?? []).filter((account) => !account.isClosed)

  /*
   * Built once and reused by every picker on this screen — the matching list renders one per
   * account named in the file, and a household can easily have forty of each.
   */
  const accountOptions = openAccounts.map((account) => ({
    value: account.id,
    label: account.name,
    hint: [account.institutionName, account.mask].filter(Boolean).join(' · '),
  }))

  const inspect = useMutation({
    mutationFn: async (file: File) => {
      const content = await file.text()
      return { content, filename: file.name, inspection: await inspectCsv(content) }
    },
    onSuccess: (result) => {
      setMapping(result.inspection.mapping)
      setAccountMap({})
      setStage({ kind: 'map', ...result })
    },
  })

  /*
   * The account values the file itself names, when a column has been mapped to `account`.
   *
   * Read from the mapping rather than from the guess, so changing which column means "account"
   * updates this without another upload — inspect returns the distinct values for every column.
   */
  const namedAccounts =
    stage.kind === 'map'
      ? (stage.inspection.distinct[
          mapping.find((column) => column.role === 'account')?.columnIndex ?? -1
        ] ?? null)
      : null

  const matchedCount = (namedAccounts ?? []).filter(
    (name) => (accountMap[name] ?? '') !== '',
  ).length

  /*
   * A close date is required before anything can be created with it.
   *
   * Without one there is no answer to when the account stopped counting, and the series would have
   * nowhere to end — so this blocks rather than defaulting to today, which would quietly invent a
   * date and put a cliff in the chart on it.
   */
  const draftsIncomplete = (namedAccounts ?? []).some(
    (name) => accountMap[name] === CREATE_SENTINEL && (drafts[name]?.closedOn ?? '') === '',
  )

  /*
   * Created first, then matched.
   *
   * The accounts have to exist before staging can route rows into them, so this resolves every
   * draft into a real account id and folds the results into the map that gets sent.
   */
  const createDrafts = async (): Promise<Record<string, string>> => {
    const resolved: Record<string, string> = { ...accountMap }

    for (const [fileName, draft] of Object.entries(drafts)) {
      if (accountMap[fileName] !== CREATE_SENTINEL) continue

      const created = await createManualAccount({
        name: fileName,
        institutionName: fileName,
        type: draft.type as (typeof ACCOUNT_TYPES)[number],
        // Closed accounts end at zero. Anything else is set on the account afterwards.
        balance: '0.00',
        effectiveDate: draft.closedOn,
        closedOn: draft.closedOn,
      })

      resolved[fileName] = created.accountId
    }

    return resolved
  }

  const stageRows = useMutation({
    mutationFn: async (input: { content: string; filename: string }) => {
      const resolved = namedAccounts === null ? accountMap : await createDrafts()

      return stageImport({
        content: input.content,
        presetId,
        kind: 'transactions',
        // One or the other, never both: a file that names its accounts routes per row, and a file
        // that does not goes to the single chosen account.
        ...(namedAccounts === null
          ? { targetAccountId: accountId }
          : {
              accountMap: namedAccounts
                .filter((name) => {
                  const target = resolved[name] ?? ''
                  return target !== '' && target !== CREATE_SENTINEL
                })
                .map((name) => ({ value: name, accountId: resolved[name] as string })),
            }),
        originalFilename: input.filename,
        mapping,
      })
    },
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
    <div>
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
          {/*
            One account, or many. A whole-portfolio export names an account on every row, and
            offering a single destination for it would quietly file everything in one place.
          */}
          {namedAccounts === null ? (
            <Field label={IMPORT_COPY.account} help={IMPORT_COPY.accountHelp}>
              <SearchableSelect
                value={accountId}
                onChange={setAccountId}
                label={IMPORT_COPY.account}
                placeholder="—"
                options={accountOptions}
              />
            </Field>
          ) : (
            <section className="mt-4">
              <h2 className="text-sm font-semibold">{IMPORT_COPY.accountsHeading}</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {IMPORT_COPY.accountsHelp}
              </p>

              <ul className="mt-2 space-y-2">
                {namedAccounts.map((name) => (
                  <li
                    key={name}
                    className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
                        {name}
                      </span>
                      <SearchableSelect
                        align="end"
                        className="w-56 shrink-0"
                        value={accountMap[name] ?? ''}
                        onChange={(next) =>
                          setAccountMap((current) => ({ ...current, [name]: next }))
                        }
                        label={name}
                        options={[
                          { value: '', label: IMPORT_COPY.accountUnmatched },
                          ...accountOptions,
                          // Last, because matching an existing account is the common case.
                          { value: CREATE_SENTINEL, label: IMPORT_COPY.accountCreate },
                        ]}
                      />
                    </div>

                    {accountMap[name] === CREATE_SENTINEL && (
                      <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                            {IMPORT_COPY.accountCreateType}
                            <select
                              value={drafts[name]?.type ?? 'depository'}
                              onChange={(event) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [name]: {
                                    closedOn: current[name]?.closedOn ?? '',
                                    type: event.target.value,
                                  },
                                }))
                              }
                              className={cn(selectClass, 'mt-1 w-40')}
                            >
                              {ACCOUNT_TYPES.map((type) => (
                                <option key={type} value={type}>
                                  {type}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                            {IMPORT_COPY.accountCreateClosedOn}
                            <input
                              type="date"
                              value={drafts[name]?.closedOn ?? ''}
                              onChange={(event) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [name]: {
                                    type: current[name]?.type ?? 'depository',
                                    closedOn: event.target.value,
                                  },
                                }))
                              }
                              className={cn(
                                'mt-1 block min-h-11 rounded-lg border px-3 text-base',
                                'border-slate-300 bg-white text-slate-900',
                                'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
                                'focus-visible:outline-2 focus-visible:outline-sky-500',
                              )}
                            />
                          </label>
                        </div>

                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                          {IMPORT_COPY.accountCreateHelp}
                        </p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              <p
                className={cn(
                  'mt-2 text-xs',
                  matchedCount === namedAccounts.length
                    ? 'text-slate-500 dark:text-slate-400'
                    : 'text-amber-700 dark:text-amber-400',
                )}
              >
                {IMPORT_COPY.accountsMatched(matchedCount, namedAccounts.length)}
              </p>
            </section>
          )}

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
            disabled={
              (namedAccounts === null ? accountId === '' : matchedCount === 0) ||
              draftsIncomplete ||
              mapping.length === 0 ||
              stageRows.isPending
            }
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
