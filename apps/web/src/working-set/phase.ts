/**
 * Which of three things the working set is currently doing.
 *
 * A phase rather than two independent booleans, because the bug this replaces was the two
 * disagreeing. `isLoading` and `isEmpty` were computed separately, and on a fresh sign-in they took
 * turns being wrong: the screen showed an empty chart, then the "connect an institution" screen,
 * then the real data — three renders, two of them false statements about someone's finances.
 *
 * **The mistake underneath was treating an empty store as an answer.** IndexedDB is local, so
 * reading it resolves in milliseconds; on a first sign-in it resolves to nothing at all. That is not
 * "this household has no accounts", it is "we have not asked the server yet", and the two want
 * opposite screens. Nothing distinguished them, so the fast local answer won and the slow true one
 * arrived later as a correction.
 *
 * A returning reader is unaffected on purpose. Their store has content, so this reports `ready`
 * immediately and the sync behind it is a background refresh — blanking a screen someone is already
 * reading, to refresh numbers that are already right, is its own bug.
 */

export type WorkingSetPhase =
  /** Nothing to show yet, and something is still on its way. */
  | 'loading'
  /** Settled: the store has been populated and there is genuinely nothing in it. */
  | 'empty'
  /** There is something to draw. */
  | 'ready'

export type PhaseInput = {
  /** The local store read has not resolved even once. */
  storeLoading: boolean
  /** The store resolved, and what it holds derives to no sections. */
  storeIsEmpty: boolean
  /** A **first** sync is in flight. False for a background refresh over existing data. */
  syncLoading: boolean
  /** How many rows the last completed sync reported writing. */
  syncChangedCount: number
  /** When the store query last produced data. Zero if never. */
  storeUpdatedAt: number
  /** When the sync query last produced data. Zero if never. */
  syncUpdatedAt: number
}

export function resolveWorkingSetPhase(input: PhaseInput): WorkingSetPhase {
  if (input.storeLoading) return 'loading'
  if (!input.storeIsEmpty) return 'ready'

  /*
   * The store is empty. The only question left is whether that is the final answer.
   *
   * It is not while a first sync is still running, and it is not in the gap after that sync lands
   * with rows but before the re-read it triggers has finished — a window of a frame or two in which
   * the store still holds nothing and nothing is in flight to say otherwise. That gap is the second
   * flash: "connect an institution", to someone whose accounts had just arrived.
   */
  const writtenButNotRead =
    input.syncChangedCount > 0 && input.storeUpdatedAt < input.syncUpdatedAt

  return input.syncLoading || writtenButNotRead ? 'loading' : 'empty'
}
