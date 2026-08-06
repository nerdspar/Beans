import { ACCOUNT_TYPES, COLUMN_ROLES, IMPORT_COPY, IMPORT_PRESETS, findPreset } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { takePendingImportFile } from '../import/pending-file.js'
import { sampleCsv, sampleCsvFilename } from '../import/sample-csv.js'
import { formatShortDate } from '../net-worth/display.js'
import { createManualAccount, listManagedAccounts } from '../accounts/api.js'
import {
  commitImport,
  inspectCsv,
  previewImport,
  listImports,
  reverseImport,
  stageImport,
  type Inspection,
} from '../import/api.js'
import { Download, Loader2 } from 'lucide-react'
import { SETTINGS_COPY } from '@beans/shared'
import { getHousehold, setTrustImportedHistory } from '../household/api.js'
import { matchAccountsByMask } from '@beans/shared'
import { cn } from '../lib/cn.js'
import { useImportProgress } from '../import/use-import-progress.js'
import type { ImportProgress } from '../import/api.js'
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
   * A file chosen on Manage accounts, where the entry point is a real file input.
   *
   * Consumed once on arrival, so this screen opens at the mapping rather than asking for the file
   * a second time. Reaching `/import` directly leaves it null and the chooser below is shown, which
   * is also what a reload does — the reference does not survive one, and resurrecting a file from a
   * previous visit would be the more surprising behaviour.
   */
  const startInspect = inspect.mutate
  useEffect(() => {
    const pending = takePendingImportFile()
    if (pending !== null) startInspect(pending)
  }, [startInspect])

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

  /*
   * Pre-matched on the last four digits, once per file.
   *
   * An export names accounts the way the institution writes them — "Scott Checking - Ending in
   * 9224" — and the provider already reports that same last four as the account's mask. Most of a
   * forty-account file decides itself.
   *
   * Only fills blanks, so nothing here can overwrite an answer already given, and it runs on the
   * names rather than on every render — re-running after a manual change would put the guess back.
   */
  const autoMatchedFor = useRef<string | null>(null)

  useEffect(() => {
    if (namedAccounts === null || accounts.data === undefined) return

    const signature = namedAccounts.join('\u0000')
    if (autoMatchedFor.current === signature) return
    autoMatchedFor.current = signature

    const guessed = matchAccountsByMask(namedAccounts, openAccounts, accountMap)
    if (Object.keys(guessed).length > 0) {
      setAccountMap((current) => ({ ...guessed, ...current }))
    }
  }, [namedAccounts, accounts.data, openAccounts, accountMap])

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
              /*
                Skips, stated rather than implied by absence.
                
                They used to be filtered out with everything unanswered, so the server could not
                tell a decision from an oversight — and a re-import that mapped one account and
                skipped forty reported forty errors for forty deliberate choices.
              */
              skippedAccounts: namedAccounts.filter((name) => (resolved[name] ?? '') === ''),
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

  /*
   * Polled only while one of the two long calls is in flight.
   *
   * Both are minutes long on a large file and neither says anything until it returns, which is
   * exactly how a working import gets killed by somebody assuming it had hung.
   */
  const progress = useImportProgress(stageRows.isPending || commit.isPending)

  /*
   * The same household setting the settings screen holds, offered where the decision is live.
   *
   * Toggling it rebuilds every account, which is why it is not folded into the commit button —
   * somebody should be able to change their mind about it without re-importing anything.
   */
  const household = useQuery({ queryKey: ['household'], queryFn: getHousehold })

  const trust = useMutation({
    mutationFn: setTrustImportedHistory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['household'] })
      await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
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

          {/*
            The example, beside the picker rather than in documentation.

            The question it answers — "will my export work?" — is had at exactly this moment, and a
            sample two clicks away in a README is a sample nobody opens. Built in the browser from
            the selected preset, so it costs no request and always matches the app named above.
          */}
          <div className="mt-6 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <h2 className="text-xs font-semibold">{IMPORT_COPY.sampleHeading}</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {IMPORT_COPY.sampleDetail}
            </p>
            <button
              type="button"
              onClick={() => downloadSample(presetId)}
              className={cn(
                'mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium',
                'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
                'focus-visible:outline-2 focus-visible:outline-sky-500',
              )}
            >
              <Download className="size-3.5" aria-hidden />
              {IMPORT_COPY.sampleAction}
            </button>
          </div>
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
                          /*
                            Second, directly under skip.
                            
                            It used to sit last, on the reasoning that matching an existing account
                            is the common case — true, but the common case is now *pre-selected*,
                            so a list being opened at all is usually one of the two exceptions.
                            Scrolling past forty accounts to reach the other one is the wrong shape.
                          */
                          { value: CREATE_SENTINEL, label: IMPORT_COPY.accountCreate },
                          ...accountOptions,
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
            {stageRows.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {stageRows.isPending ? IMPORT_COPY.staging : IMPORT_COPY.stage}
          </button>

          <RunningCount progress={progress} />
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
            <>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {IMPORT_COPY.rowsParsed(
                  preview.data.totalRows - preview.data.failedRows - preview.data.skippedRows,
                  preview.data.totalRows,
                )}
              </p>

              {/* Ordinary text, not red: a skip is a decision the reader already made. */}
              {preview.data.skippedRows > 0 && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {IMPORT_COPY.rowsSkipped(preview.data.skippedRows)}
                </p>
              )}

              {preview.data.failedRows > 0 && (
                <p className="mt-1 text-xs text-rose-700 dark:text-rose-400">
                  {IMPORT_COPY.rowsFailed(preview.data.failedRows)}
                </p>
              )}
            </>
          )}

          {/*
            Why rows were set aside, counted over the whole file.
            
            The list below stops at fifty rows, so an account skipped halfway down a fourteen-thousand
            row export left no visible trace — the preview looked clean and the only evidence was a
            total that did not add up.
          */}
          {(preview.data?.reasons.length ?? 0) > 0 && (
            <ul className="mt-2 space-y-1">
              {preview.data?.reasons.map((entry) => (
                <li
                  key={entry.reason}
                  className="flex items-baseline justify-between gap-3 text-xs text-rose-700 dark:text-rose-400"
                >
                  <span className="min-w-0 truncate">{entry.reason}</span>
                  <span className="shrink-0 tabular-nums">{entry.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}

          <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
            {(preview.data?.rows ?? []).map((row) => (
              <li key={row.rowNumber} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">{row.description ?? '—'}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{row.date ?? '—'}</p>
                </div>
                {/*
                  Red is for something that needs a decision, not for anything with a reason.
                  
                  A skipped row carries one too — naming the account it belonged to — and colouring
                  it the same made a page of deliberate choices read as a page of errors, which is
                  the thing this whole distinction exists to stop.
                */}
                <span
                  className={cn(
                    'shrink-0 text-sm tabular-nums',
                    row.status === 'failed' && 'text-rose-600 dark:text-rose-400',
                    row.status === 'skipped' && 'text-slate-400 dark:text-slate-500',
                  )}
                >
                  {row.error ?? row.amount ?? '—'}
                </span>
              </li>
            ))}
          </ul>

          {/*
            Asked here because this is where the question is live.
            
            The same switch is in settings, and it has to be — somebody only learns whether they
            trust an export after seeing what it draws. But burying it there alone means the one
            moment they are holding the file and know what is in it is the one moment they are not
            asked.
          */}
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <input
              type="checkbox"
              checked={household.data?.trustImportedHistory ?? false}
              disabled={household.data === undefined || trust.isPending}
              onChange={(event) => trust.mutate(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-sky-600"
            />
            <span className="text-sm">
              <span className="font-medium">{SETTINGS_COPY.historyTrustLabel}</span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                {household.data?.trustImportedHistory === true
                  ? SETTINGS_COPY.historyTrustOn
                  : SETTINGS_COPY.historyTrustOff}
              </span>
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                {SETTINGS_COPY.historyTrustReversible}
              </span>
              {trust.isPending && (
                <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {SETTINGS_COPY.historyTrustRebuilding}
                </span>
              )}
            </span>
          </label>

          <Problem error={commit.error} fallback={IMPORT_COPY.commitFailed} />

          <button
            type="button"
            disabled={commit.isPending}
            onClick={() => commit.mutate()}
            className={primaryClass}
          >
            {commit.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {commit.isPending ? IMPORT_COPY.committing : IMPORT_COPY.commit}
          </button>

          <RunningCount progress={progress} />
        </div>
      )}

      {/*
        Past imports, so undo is reachable after leaving the screen that offered it.
        
        Only on the opening stage: mid-import the reader is answering questions about *this* file,
        and a list of previous ones underneath is noise at exactly the wrong moment.
      */}
      {stage.kind === 'choose' && (
        <ImportHistory
          onReversed={async () => {
            await queryClient.invalidateQueries({ queryKey: ['imports'] })
            // Reversing deletes transactions and rebuilds history, so every chart is stale.
            await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
            await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
          }}
        />
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
  'mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold',
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

/**
 * The live count, while a stage or commit runs.
 *
 * A number rather than a bar. "8,412 of 14,411" answers both questions somebody staring at a frozen
 * screen actually has — is it moving, and how much is left — where a bar answers only the second and
 * a spinner alone answers only the first.
 *
 * Renders nothing between the request leaving and the first poll arriving, which is right: an
 * invented "0 of 0" would be the one reading guaranteed to be wrong.
 */
function RunningCount({ progress }: { progress: ImportProgress | null }): ReactNode {
  if (progress === null || progress.total === 0) return null

  return (
    <p
      // Polite: it updates twice a second, and interrupting a screen reader that often is unusable.
      aria-live="polite"
      className="mt-2 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400"
    >
      {progress.phase === 'reading'
        ? IMPORT_COPY.progressReading(progress.done, progress.total)
        : IMPORT_COPY.progressCommitting(progress.done, progress.total)}
    </p>
  )
}

/**
 * Previous imports, with an undo for the ones still inside their window.
 *
 * Reversibility already had a lifetime in the data — `reversible_until`, thirty days — and no
 * surface. This is the surface, not new behaviour.
 */
function ImportHistory({ onReversed }: { onReversed: () => Promise<void> }): ReactNode {
  const imports = useQuery({ queryKey: ['imports'], queryFn: listImports })

  /** Which row is asking. Undo deletes transactions, so it never fires on the first tap. */
  const [confirming, setConfirming] = useState<string | null>(null)

  const reverse = useMutation({
    mutationFn: reverseImport,
    onSuccess: async () => {
      setConfirming(null)
      await onReversed()
    },
  })

  const redo = useMutation({
    mutationFn: commitImport,
    onSuccess: async () => {
      await onReversed()
    },
  })

  const rows = imports.data ?? []
  if (rows.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">{IMPORT_COPY.historyHeading}</h2>

      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {rows.map((record) => {
          const undoable =
            record.status === 'committed' &&
            record.reversibleUntil !== null &&
            new Date(record.reversibleUntil).getTime() > Date.now()

          return (
            <li key={record.id} className="py-2.5">
              <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{record.originalFilename}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {record.status === 'reversed'
                    ? IMPORT_COPY.historyReversed
                    : record.status !== 'committed'
                      ? IMPORT_COPY.historyStaged
                      : IMPORT_COPY.historyRows(record.committedRowCount ?? 0, record.rowCount)}
                  {record.status === 'committed' &&
                    ` · ${
                      undoable && record.reversibleUntil !== null
                        ? IMPORT_COPY.historyReversibleUntil(
                            formatShortDate(record.reversibleUntil.slice(0, 10)),
                          )
                        : IMPORT_COPY.historyNotReversible
                    }`}
                </p>
              </div>

              {/*
                Reversed imports offer to come back.
                
                Undo leaves every staged row in place, so redo is a re-commit rather than a
                re-upload — which is what makes the confirmation below a fair thing to ask.
              */}
              {record.status === 'reversed' && (
                <button
                  type="button"
                  onClick={() => redo.mutate(record.id)}
                  disabled={redo.isPending}
                  className={cn(
                    'shrink-0 rounded-lg border px-3 py-2 text-xs font-medium',
                    'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
                    'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
                  )}
                >
                  {redo.isPending ? IMPORT_COPY.redoing : IMPORT_COPY.redo}
                </button>
              )}

              {undoable && confirming !== record.id && (
                <button
                  type="button"
                  onClick={() => setConfirming(record.id)}
                  className={cn(
                    'shrink-0 rounded-lg border px-3 py-2 text-xs font-medium',
                    'border-slate-300 text-rose-600 hover:bg-rose-50',
                    'dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950/40',
                    'focus-visible:outline-2 focus-visible:outline-rose-600',
                  )}
                >
                  {IMPORT_COPY.reverse}
                </button>
              )}
              </div>

              {/*
                Asked, not assumed.

                Undo deletes transactions — thousands on a whole-portfolio file — and it used to go
                on a single tap. The count is in the question because it is the one number that
                makes the size of the action obvious before it happens, and the reassurance beneath
                it is there because it is true: the staged rows survive, so this is undoable in turn.
              */}
              {confirming === record.id && (
                <div className="mt-2 rounded-xl border border-rose-300 p-3 dark:border-rose-900">
                  <p className="text-sm font-medium">
                    {IMPORT_COPY.reverseConfirm(record.committedRowCount ?? 0)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {IMPORT_COPY.reverseConfirmDetail}
                  </p>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => reverse.mutate(record.id)}
                      disabled={reverse.isPending}
                      className={cn(
                        'min-h-9 rounded-lg bg-rose-600 px-3 text-xs font-medium text-white',
                        'focus-visible:outline-2 focus-visible:outline-offset-2',
                        'focus-visible:outline-rose-500 disabled:opacity-50',
                      )}
                    >
                      {reverse.isPending
                        ? IMPORT_COPY.reversing
                        : IMPORT_COPY.reverseConfirmAction}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className={cn(
                        'min-h-9 rounded-lg border px-3 text-xs font-medium',
                        'border-slate-300 hover:bg-slate-100',
                        'dark:border-slate-700 dark:hover:bg-slate-800',
                      )}
                    >
                      {IMPORT_COPY.reverseCancel}
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <Problem error={reverse.error} fallback={IMPORT_COPY.commitFailed} />
    </section>
  )
}

/**
 * Hands the browser a generated file.
 *
 * An object URL rather than a `data:` URI: Safari caps those at a couple of megabytes and silently
 * does nothing past it. The sample is tiny today, but a download that quietly fails on one browser
 * is the kind of thing nobody reports — they conclude the button is broken and give up on the
 * import instead.
 *
 * Revoked immediately after the click. The blob is held alive by the download itself, and leaving
 * the URL registered leaks it for the life of the document.
 */
function downloadSample(presetId: string): void {
  const preset = findPreset(presetId) ?? findPreset('custom')
  if (preset === undefined) return

  const url = URL.createObjectURL(new Blob([sampleCsv(preset)], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = sampleCsvFilename(preset)
  link.click()
  URL.revokeObjectURL(url)
}
