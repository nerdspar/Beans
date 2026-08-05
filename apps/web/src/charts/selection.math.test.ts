import { describe, expect, it } from 'vitest'
import { nextSelection, type ChartSelection } from './selection.js'
import { isTap } from './use-chart-scrub.js'

/**
 * Holding a point on a chart.
 *
 * Two rules, and the interesting one is that **only a tap toggles**. A drag ends on the index it
 * was already reading, so treating release as a toggle would clear the selection the instant a
 * finger lifted — the whole interaction on a phone, broken by the obvious implementation.
 */

const MARCH: ChartSelection = { kind: 'month', month: '2026-03' }
const APRIL: ChartSelection = { kind: 'month', month: '2026-04' }
const DAY: ChartSelection = { kind: 'day', date: '2026-03-11' }

describe('nextSelection', () => {
  it('holds what a tap landed on when nothing was held', () => {
    expect(nextSelection(null, MARCH, true)).toEqual(MARCH)
  })

  it('clears when the held thing is tapped again', () => {
    expect(nextSelection(MARCH, MARCH, true)).toBeNull()
  })

  it('moves when a different thing is tapped', () => {
    expect(nextSelection(MARCH, APRIL, true)).toEqual(APRIL)
  })

  /**
   * The rule the whole thing turns on. A drag reads continuously and releases on the point it was
   * already showing; if that release toggled, dragging to a day and lifting your finger would clear
   * it, and nothing could ever be held on a touchscreen.
   */
  it('never clears on the end of a drag, even on the held point', () => {
    expect(nextSelection(MARCH, MARCH, false)).toEqual(MARCH)
  })

  it('sets on the end of a drag like any other commit', () => {
    expect(nextSelection(MARCH, APRIL, false)).toEqual(APRIL)
    expect(nextSelection(null, APRIL, false)).toEqual(APRIL)
  })

  /** A month and a day are never the same selection, whatever dates they carry. */
  it('does not confuse a day with a month', () => {
    expect(nextSelection(MARCH, DAY, true)).toEqual(DAY)
    expect(nextSelection(DAY, MARCH, true)).toEqual(MARCH)
  })

  it('clears when the held day is tapped again', () => {
    expect(nextSelection(DAY, { kind: 'day', date: '2026-03-11' }, true)).toBeNull()
  })

  it('moves between days', () => {
    expect(nextSelection(DAY, { kind: 'day', date: '2026-03-12' }, true)).toEqual({
      kind: 'day',
      date: '2026-03-12',
    })
  })
})

describe('isTap', () => {
  it('treats a press that did not move as a tap', () => {
    expect(isTap(140, 140)).toBe(true)
  })

  /** A finger never lands and lifts on exactly one pixel, and a tap that misses cannot be undone. */
  it('tolerates a small wobble', () => {
    expect(isTap(140, 144)).toBe(true)
    expect(isTap(140, 136)).toBe(true)
  })

  it('treats a deliberate drag as a drag', () => {
    expect(isTap(140, 200)).toBe(false)
    expect(isTap(200, 140)).toBe(false)
  })

  it('is symmetric', () => {
    expect(isTap(100, 130)).toBe(isTap(130, 100))
  })
})
