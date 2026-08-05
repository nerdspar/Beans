import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'

/**
 * Reading a chart with a pointer or a keyboard, shared by every chart that can be read.
 *
 * Extracted when a second chart needed the same behaviour and a third was about to. What differs
 * between them is only *which* index a position maps to — nearest point on a line, containing slot
 * on a bar — so that is the parameter and everything else is common.
 *
 * ## Tap and drag are different gestures
 *
 * A drag reads continuously and leaves its last reading pinned. A tap toggles: tapping the pinned
 * thing again clears it. Telling them apart is not decoration — a drag ends on the index it was
 * already reading, so treating release as a tap would clear the selection the instant a finger
 * lifted, which is the entire interaction on a phone.
 */

/** Movement beyond this is a drag. Below it, a finger that wobbled while tapping. */
const TAP_SLOP_PX = 6

/**
 * Whether a press was a tap rather than a drag.
 *
 * The slop exists because a finger never lands and lifts on exactly one pixel. Too tight and a tap
 * registers as a one-pixel drag, which sets instead of toggling and makes clearing impossible; too
 * loose and a short deliberate drag toggles the selection off.
 */
export function isTap(startX: number, endX: number): boolean {
  return Math.abs(endX - startX) <= TAP_SLOP_PX
}

export type ChartScrubOptions = {
  /** How many readable points the chart has. */
  count: number
  /** Maps a position within the plot to an index. Null when there is nothing there. */
  resolveIndex: (offsetX: number, width: number) => number | null
  /** Transient reading — hover, or mid-drag. Null when the pointer leaves. */
  onScrub: ((index: number | null) => void) | undefined
  /**
   * A committed reading: the end of a drag, or a tap.
   *
   * `viaTap` is true only for a press that did not move. The caller uses it to decide between
   * setting the selection and toggling it.
   */
  onSelect?: ((index: number, viaTap: boolean) => void) | undefined
  /** Index currently being read, so the keyboard knows where to move from. */
  scrubIndex: number | null
  /** Extra keyboard jumps beyond one step. A daily chart wants a week; a monthly one does not. */
  pageStep?: number | undefined
}

export type ChartScrubHandlers = {
  plotRef: RefObject<HTMLDivElement | null>
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

export function useChartScrub({
  count,
  resolveIndex,
  onScrub,
  onSelect,
  scrubIndex,
  pageStep,
}: ChartScrubOptions): ChartScrubHandlers {
  const plotRef = useRef<HTMLDivElement>(null)
  /** Where the press began, for deciding whether it turned into a drag. */
  const pressedAt = useRef<number | null>(null)

  const indexFor = useCallback(
    (clientX: number): number | null => {
      const box = plotRef.current?.getBoundingClientRect()
      if (box === undefined) return null
      return resolveIndex(clientX - box.left, box.width)
    },
    [resolveIndex],
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Captured so a finger that slides off the chart keeps reading rather than dropping mid-gesture.
    event.currentTarget.setPointerCapture(event.pointerId)
    pressedAt.current = event.clientX

    const index = indexFor(event.clientX)
    if (index !== null) onScrub?.(index)
  }

  /**
   * One handler for mouse, pen and touch.
   *
   * A mouse reports movement with no button held, which is the hover a desktop wants. Touch reports
   * it only while the finger is down, which is the drag a phone wants.
   */
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const dragging = event.currentTarget.hasPointerCapture(event.pointerId)
    if (event.pointerType !== 'mouse' && !dragging) return

    const index = indexFor(event.clientX)
    if (index !== null) onScrub?.(index)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pressedAt.current
    pressedAt.current = null

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const index = indexFor(event.clientX)
    if (index !== null && start !== null) {
      onSelect?.(index, isTap(start, event.clientX))
    }

    /*
     * The transient reading ends here even though a selection may have been made. A pinned
     * selection is the screen's state, not the chart's — the chart shows what it is told to.
     */
    onScrub?.(null)
  }

  const endWithoutSelecting = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pressedAt.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onScrub?.(null)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (count === 0 || onScrub === undefined) return

    const last = count - 1
    const from = scrubIndex ?? last

    // Enter and Space commit, matching a tap — the only way to pin without a pointer.
    if (event.key === 'Enter' || event.key === ' ') {
      onSelect?.(from, true)
      event.preventDefault()
      return
    }

    const absolute: Record<string, number | null> = { Escape: null, Home: 0, End: last }
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 }
    if (pageStep !== undefined) {
      step['PageUp'] = -pageStep
      step['PageDown'] = pageStep
    }

    if (event.key in absolute) {
      onScrub(absolute[event.key] ?? null)
    } else if (event.key in step) {
      onScrub(Math.min(last, Math.max(0, from + (step[event.key] ?? 0))))
    } else {
      return
    }

    // Stops arrow keys scrolling the page out from under a chart being read.
    event.preventDefault()
  }

  return {
    plotRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: endWithoutSelecting,
    // Only meaningful for a mouse: a captured touch never fires this, and a mouse that has left has
    // stopped reading. A selection is not committed, because leaving is not choosing.
    onPointerLeave: endWithoutSelecting,
    onKeyDown,
  }
}
