import { describe, expect, it } from 'vitest'
import { resolveWorkingSetPhase, type PhaseInput } from './phase.js'

/**
 * The sign-in sequence, as a state machine.
 *
 * The bug these exist for was not a wrong value, it was a wrong *order*: on a first sign-in the
 * screen showed an empty chart, then "connect an institution", then the real data. Both intermediate
 * frames were confident claims about someone's money, and both were false.
 *
 * So the test that matters is the sequence one at the bottom. The rest pin the individual states it
 * walks through.
 */

/** Fixed timestamps, never `Date.now()` — these are orderings, and the ordering is the subject. */
const T_STORE_FIRST_READ = 1_000
const T_SYNC_LANDED = 2_000
const T_STORE_REREAD = 3_000

const base: PhaseInput = {
  storeLoading: false,
  storeIsEmpty: true,
  syncLoading: false,
  syncChangedCount: 0,
  storeUpdatedAt: T_STORE_FIRST_READ,
  syncUpdatedAt: 0,
}

describe('resolveWorkingSetPhase', () => {
  it('loads while the local store has never been read', () => {
    expect(resolveWorkingSetPhase({ ...base, storeLoading: true })).toBe('loading')
  })

  it('is ready the moment the store has content, without waiting for a sync', () => {
    // A returning reader must not be blanked to refresh numbers that are already correct.
    expect(
      resolveWorkingSetPhase({ ...base, storeIsEmpty: false, syncLoading: true }),
    ).toBe('ready')
  })

  it('loads, not empty, while the first sync is still running', () => {
    // The first wrong frame: an empty store is not an empty household.
    expect(resolveWorkingSetPhase({ ...base, syncLoading: true })).toBe('loading')
  })

  it('loads through the gap after a sync writes rows but before the store is re-read', () => {
    // The second wrong frame. Sync is finished, so nothing is "in flight" — but the store still
    // holds nothing, and the accounts it just wrote are one re-read away.
    expect(
      resolveWorkingSetPhase({
        ...base,
        syncChangedCount: 42,
        syncUpdatedAt: T_SYNC_LANDED,
        storeUpdatedAt: T_STORE_FIRST_READ,
      }),
    ).toBe('loading')
  })

  it('is empty once a sync completes having written nothing', () => {
    // A genuinely new household. This is the one case where "connect an institution" is true, and
    // it must still be reachable — the fix must not make the empty state unreachable.
    expect(
      resolveWorkingSetPhase({ ...base, syncChangedCount: 0, syncUpdatedAt: T_SYNC_LANDED }),
    ).toBe('empty')
  })

  it('is empty when the sync failed and left the store untouched', () => {
    // Not loading forever. The screen above this reports the error itself; what matters here is
    // that the phase settles rather than spinning against a server that is not answering.
    expect(
      resolveWorkingSetPhase({ ...base, syncLoading: false, syncUpdatedAt: 0 }),
    ).toBe('empty')
  })

  it('does not re-enter loading when a later sync writes rows over a populated store', () => {
    // A sync landing on a screen already showing data is a background refresh. The
    // written-but-not-read window exists, but the reader has content and must keep it.
    expect(
      resolveWorkingSetPhase({
        ...base,
        storeIsEmpty: false,
        syncChangedCount: 9,
        syncUpdatedAt: T_SYNC_LANDED,
        storeUpdatedAt: T_STORE_FIRST_READ,
      }),
    ).toBe('ready')
  })

  it('walks a first sign-in without ever passing through empty', () => {
    /*
     * The whole point, as one sequence.
     *
     * Previously this went ready(nothing) -> empty -> ready, rendering an empty chart and then an
     * onboarding screen to somebody who had eight years of history. It must go loading -> ready,
     * with no frame in between that says anything untrue.
     */
    const steps: PhaseInput[] = [
      // The local read has not resolved.
      { ...base, storeLoading: true, syncLoading: true },
      // It resolves, to nothing. Sync still running.
      { ...base, syncLoading: true },
      // Sync lands with rows; the re-read has not happened.
      { ...base, syncChangedCount: 128, syncUpdatedAt: T_SYNC_LANDED },
      // The re-read lands.
      {
        ...base,
        storeIsEmpty: false,
        syncChangedCount: 128,
        syncUpdatedAt: T_SYNC_LANDED,
        storeUpdatedAt: T_STORE_REREAD,
      },
    ]

    expect(steps.map(resolveWorkingSetPhase)).toEqual([
      'loading',
      'loading',
      'loading',
      'ready',
    ])
  })
})
