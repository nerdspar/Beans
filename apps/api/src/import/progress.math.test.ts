import { describe, expect, it } from 'vitest'
import {
  advanceProgress,
  beginProgress,
  endProgress,
  readProgress,
} from './progress.js'

const HOUSEHOLD = 'household-a'
const OTHER = 'household-b'

describe('import progress', () => {
  it('reports nothing when nothing is running', () => {
    endProgress(HOUSEHOLD)
    expect(readProgress(HOUSEHOLD)).toBeNull()
  })

  it('reports the phase and total as soon as a run begins', () => {
    beginProgress(HOUSEHOLD, 'reading', 14_411)
    expect(readProgress(HOUSEHOLD)).toEqual({ phase: 'reading', done: 0, total: 14_411 })
    endProgress(HOUSEHOLD)
  })

  it('advances on a publish boundary', () => {
    beginProgress(HOUSEHOLD, 'reading', 1000)
    advanceProgress(HOUSEHOLD, 100, 1000)
    expect(readProgress(HOUSEHOLD)?.done).toBe(100)
    endProgress(HOUSEHOLD)
  })

  /** Publishing every row would be thousands of writes to move a bar the eye reads a few times a second. */
  it('does not publish between boundaries', () => {
    beginProgress(HOUSEHOLD, 'reading', 1000)
    advanceProgress(HOUSEHOLD, 100, 1000)
    advanceProgress(HOUSEHOLD, 137, 1000)
    expect(readProgress(HOUSEHOLD)?.done).toBe(100)
    endProgress(HOUSEHOLD)
  })

  /**
   * The case that would otherwise strand the bar short of the end: a file whose row count is not a
   * multiple of the publish interval never lands on a boundary.
   */
  it('always publishes the final row', () => {
    beginProgress(HOUSEHOLD, 'reading', 14_411)
    advanceProgress(HOUSEHOLD, 14_411, 14_411)
    expect(readProgress(HOUSEHOLD)?.done).toBe(14_411)
    endProgress(HOUSEHOLD)
  })

  it('keeps the phase across advances', () => {
    beginProgress(HOUSEHOLD, 'committing', 500)
    advanceProgress(HOUSEHOLD, 500, 500)
    expect(readProgress(HOUSEHOLD)?.phase).toBe('committing')
    endProgress(HOUSEHOLD)
  })

  /** A stale reading is worse than none — it would read as "already nearly done". */
  it('reports nothing once the run ends', () => {
    beginProgress(HOUSEHOLD, 'reading', 100)
    advanceProgress(HOUSEHOLD, 100, 100)
    endProgress(HOUSEHOLD)
    expect(readProgress(HOUSEHOLD)).toBeNull()
  })

  it('ignores advances for a run that never began', () => {
    endProgress(HOUSEHOLD)
    advanceProgress(HOUSEHOLD, 100, 1000)
    expect(readProgress(HOUSEHOLD)).toBeNull()
  })

  /** Keyed by household, so one member's import is never reported to another's screen. */
  it('keeps households apart', () => {
    beginProgress(HOUSEHOLD, 'reading', 100)
    advanceProgress(HOUSEHOLD, 100, 100)

    expect(readProgress(OTHER)).toBeNull()
    expect(readProgress(HOUSEHOLD)?.done).toBe(100)

    endProgress(HOUSEHOLD)
  })

  it('resets when a second run begins', () => {
    beginProgress(HOUSEHOLD, 'reading', 100)
    advanceProgress(HOUSEHOLD, 100, 100)
    beginProgress(HOUSEHOLD, 'committing', 40)

    expect(readProgress(HOUSEHOLD)).toEqual({ phase: 'committing', done: 0, total: 40 })
    endProgress(HOUSEHOLD)
  })
})
