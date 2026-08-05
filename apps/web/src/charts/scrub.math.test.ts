import { describe, expect, it } from 'vitest'
import { indexAtPosition } from './AreaChart.js'

/**
 * Reading the chart by date.
 *
 * The series is one point per day, so an index *is* a day — which is what makes "moves a day at a
 * time" fall out of the geometry rather than needing to be enforced on top of it. These cover the
 * edges where that stops being obvious: the ends of a drag, a window with one day in it, and the
 * half-day either side of each point.
 */

/** A year, which is the default window. */
const YEAR = 365
const WIDTH = 1000

describe('indexAtPosition', () => {
  it('reads the first day at the left edge and the last at the right', () => {
    expect(indexAtPosition(0, WIDTH, YEAR)).toBe(0)
    expect(indexAtPosition(WIDTH, WIDTH, YEAR)).toBe(YEAR - 1)
  })

  it('reads the middle of the window in the middle of the chart', () => {
    expect(indexAtPosition(WIDTH / 2, WIDTH, YEAR)).toBe(Math.round((YEAR - 1) / 2))
  })

  /**
   * Rounding, not flooring. Flooring lands the marker a day behind the finger across the whole
   * right half of every day's width — invisible in pixels, and wrong in the number being read.
   */
  it('snaps to the nearer day rather than the earlier one', () => {
    // Ten points, so each spans a ninth of the width. Just past the midpoint between 0 and 1.
    const step = WIDTH / 9
    expect(indexAtPosition(step * 0.51, WIDTH, 10)).toBe(1)
    expect(indexAtPosition(step * 0.49, WIDTH, 10)).toBe(0)
  })

  it('moves exactly one day per step across the window', () => {
    const seen = new Set<number>()
    for (let index = 0; index < YEAR; index += 1) {
      seen.add(indexAtPosition((index / (YEAR - 1)) * WIDTH, WIDTH, YEAR) ?? -1)
    }
    // Every day in the window is reachable, and none is skipped.
    expect(seen.size).toBe(YEAR)
  })

  /** A drag that leaves the chart holds at the end instead of running off it. */
  it('clamps a position outside the chart to the nearest end', () => {
    expect(indexAtPosition(-500, WIDTH, YEAR)).toBe(0)
    expect(indexAtPosition(WIDTH * 3, WIDTH, YEAR)).toBe(YEAR - 1)
  })

  /**
   * One point is drawn as a flat line across the full width, so every position on it reads the same
   * day. Dividing by `length - 1` would be a division by zero here.
   */
  it('reads the only day there is when the window holds one point', () => {
    expect(indexAtPosition(0, WIDTH, 1)).toBe(0)
    expect(indexAtPosition(WIDTH, WIDTH, 1)).toBe(0)
  })

  it('reads nothing when there is nothing to read', () => {
    expect(indexAtPosition(500, WIDTH, 0)).toBeNull()
  })

  /** A chart that has not been laid out yet has no width, and no day is under anything. */
  it('reads nothing before the chart has a width', () => {
    expect(indexAtPosition(0, 0, YEAR)).toBeNull()
  })
})

/**
 * Reading a month that has not finished.
 *
 * The cumulative chart draws only the days that have happened, but the scrub used to resolve across
 * the whole series — so dragging into the rest of the month reported a running total for days that
 * had not occurred, and it read as real because every other position on the chart is.
 *
 * The clamp is applied *after* resolving against the full width, deliberately. Mapping the elapsed
 * days across the whole width instead would slide the reading away from the pointer, which is worse
 * than a reading that stops.
 */
describe('scrubbing a partial month', () => {
  const clampToElapsed = (
    offsetX: number,
    width: number,
    length: number,
    elapsed: number,
  ): number | null => {
    const index = indexAtPosition(offsetX, width, length)
    return index === null ? null : Math.min(index, Math.max(0, Math.min(elapsed, length) - 1))
  }

  it('reads the day under the pointer while inside the elapsed part', () => {
    // A 31-day month, 10 days elapsed. A fifth of the way across is day 7 (index 6).
    expect(clampToElapsed(200, 1000, 31, 10)).toBe(6)
  })

  it('holds at the last elapsed day beyond it', () => {
    expect(clampToElapsed(900, 1000, 31, 10)).toBe(9)
    expect(clampToElapsed(1000, 1000, 31, 10)).toBe(9)
  })

  it('does not clamp a completed month', () => {
    expect(clampToElapsed(1000, 1000, 31, 31)).toBe(30)
  })

  /** Day one of a month: the only readable point is the first. */
  it('holds at the first day when only one has elapsed', () => {
    expect(clampToElapsed(800, 1000, 31, 1)).toBe(0)
  })

  it('still reports nothing for an empty series', () => {
    expect(clampToElapsed(500, 1000, 0, 0)).toBeNull()
  })
})
