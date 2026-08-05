/**
 * How far along an import is, while it is still running.
 *
 * ## Why this is in memory rather than in a table
 *
 * Every request runs inside one transaction (`withHouseholdContext`), so rows written by the
 * staging loop are **invisible to any other connection until it commits**. Polling the database for
 * a count would return zero for the entire run and then the total, which is the one shape that
 * looks exactly like a hang.
 *
 * A row-count column updated on a second connection would work and would also mean a write per
 * batch, outside the transaction, that has to be cleaned up if the import fails. This is a number
 * on its way to a progress bar, not a fact about the household — losing it costs a spinner.
 *
 * Which makes the trade explicit: **a restart mid-import loses the progress, and that is correct.**
 * The transaction rolls back too, so there is nothing left to be in progress about.
 *
 * Keyed by household rather than by import id because staging has no id to report against yet — the
 * client learns it only when the call returns, which is the very thing it is waiting for. A
 * household imports one file at a time.
 */

export type ImportPhase = 'reading' | 'committing'

export type ImportProgress = {
  phase: ImportPhase
  /** Rows processed so far. */
  done: number
  /** Rows in the file. Zero when it is not yet known. */
  total: number
}

const active = new Map<string, ImportProgress>()

/**
 * How often the loop publishes.
 *
 * Every row would mean 14,000 map writes to move a bar the eye reads a few times a second. Every
 * few hundred is smooth at any file size and costs nothing.
 */
const PUBLISH_EVERY = 100

export function beginProgress(householdId: string, phase: ImportPhase, total: number): void {
  active.set(householdId, { phase, done: 0, total })
}

/**
 * Records progress, cheaply.
 *
 * Only writes on a boundary or the final row, so a caller can hand it every index without thinking
 * about it.
 */
export function advanceProgress(householdId: string, done: number, total: number): void {
  if (done % PUBLISH_EVERY !== 0 && done !== total) return

  const current = active.get(householdId)
  if (current === undefined) return

  active.set(householdId, { ...current, done, total })
}

/**
 * Clears it.
 *
 * **Always in a `finally`.** A run that throws and leaves its progress behind would have the next
 * poll report a stale import as still going, which is worse than reporting nothing at all.
 */
export function endProgress(householdId: string): void {
  active.delete(householdId)
}

export function readProgress(householdId: string): ImportProgress | null {
  return active.get(householdId) ?? null
}
