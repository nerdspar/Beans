import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Tracks which net worth section the user is currently inside.
 *
 * Driven by an **IntersectionObserver rooted to the bottom edge of the chart**, not by raw scroll
 * offsets. Scroll math breaks on variable row heights — every section has a different number of
 * accounts — and on mobile browser chrome resizing, where the viewport height changes mid-gesture
 * and every precomputed offset silently shifts.
 *
 * The observer's root margin collapses the viewport to a one-pixel band sitting just under the
 * chart. A section is "active" when it occupies that band, which is exactly the line the pinned
 * header sits on.
 */

export type ActiveSectionOptions = {
  /** Distance from the top of the viewport to the detection line — the chart's bottom edge. */
  lineOffset: number
  /**
   * How long a crossing must settle before it counts.
   *
   * This is the hysteresis. A fling through four sections fires four crossings in well under the
   * chart's 220ms transition, and animating each one in turn would strobe the chart through every
   * category on the way past. Waiting for the scroll to settle means the chart changes **once, to
   * where the user actually stopped**.
   *
   * Short enough to feel immediate on a deliberate scroll; long enough to swallow a fling.
   */
  settleMs?: number
}

const DEFAULT_SETTLE_MS = 90

export function useActiveSection<K extends string>(
  keys: readonly K[],
  options: ActiveSectionOptions,
): {
  /** Null while above every section — household net worth, the state you return to at the top. */
  activeKey: K | null
  registerSection: (key: K) => (element: HTMLElement | null) => void
  /** Scrolls a section to the detection line. The keyboard path to the same result. */
  scrollToSection: (key: K) => void
} {
  const { lineOffset, settleMs = DEFAULT_SETTLE_MS } = options

  const [activeKey, setActiveKey] = useState<K | null>(null)
  const elements = useRef(new Map<K, HTMLElement>())
  const settleTimer = useRef<number | undefined>(undefined)

  const registerSection = useCallback(
    (key: K) => (element: HTMLElement | null) => {
      if (element === null) {
        elements.current.delete(key)
      } else {
        elements.current.set(key, element)
      }
    },
    [],
  )

  /**
   * Reads which section owns the detection line right now, from geometry.
   *
   * The observer says *that* something crossed; this says *what is there*. Deriving the answer from
   * current rects rather than accumulating observer state means a fling that skips several sections
   * still lands on the right one — an event-counting approach would end up wherever the last
   * delivered event happened to point.
   */
  const measure = useCallback((): K | null => {
    let found: K | null = null
    let bestTop = Number.NEGATIVE_INFINITY

    for (const key of keys) {
      const element = elements.current.get(key)
      if (element === undefined) continue

      const rect = element.getBoundingClientRect()
      // The section straddling the line, or the last one to have passed above it.
      if (rect.top <= lineOffset && rect.top > bestTop) {
        bestTop = rect.top
        found = key
      }
    }

    return found
  }, [keys, lineOffset])

  useEffect(() => {
    const settle = (): void => {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(() => {
        setActiveKey((previous) => {
          const next = measure()
          // Returning the identical value skips the re-render, so a scroll that stays inside one
          // section costs nothing.
          return next === previous ? previous : next
        })
      }, settleMs)
    }

    const observer = new IntersectionObserver(settle, {
      /*
       * Collapses the viewport to a 1px band at `lineOffset`. Negative margins on both sides shrink
       * the root rather than grow it, so only an element crossing that exact line intersects.
       */
      rootMargin: `-${lineOffset}px 0px -${Math.max(0, window.innerHeight - lineOffset - 1)}px 0px`,
      threshold: 0,
    })

    for (const element of elements.current.values()) {
      observer.observe(element)
    }

    /*
     * A fling can carry the page past several sections between observer callbacks, and momentum
     * scrolling on iOS can end without a final intersection at all. Listening to scroll as well
     * means the settle timer is always re-armed while movement continues, so the measurement
     * happens after it stops rather than at the last crossing.
     */
    window.addEventListener('scroll', settle, { passive: true })
    window.addEventListener('resize', settle, { passive: true })

    // Establish the opening state without waiting for a scroll.
    settle()

    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', settle)
      window.removeEventListener('resize', settle)
      window.clearTimeout(settleTimer.current)
    }
  }, [keys, lineOffset, measure, settleMs])

  const scrollToSection = useCallback(
    (key: K) => {
      const element = elements.current.get(key)
      if (element === undefined) return

      const top = element.getBoundingClientRect().top + window.scrollY - lineOffset
      element.scrollIntoView === undefined
        ? window.scrollTo(0, top)
        : window.scrollTo({ top, behavior: 'smooth' })
    },
    [lineOffset],
  )

  return { activeKey, registerSection, scrollToSection }
}
