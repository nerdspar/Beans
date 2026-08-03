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
   * The hysteresis, in pixels.
   *
   * A new section must clear the line by this much before it takes over. That stops the flip-flop
   * when the user parks exactly on a boundary and a pixel of movement — or an address bar
   * collapsing — would otherwise toggle the chart back and forth.
   *
   * Deliberately **not** a time delay. Waiting for the scroll to settle makes the chart change once
   * per *gesture*, which reads as lag on a slow deliberate scroll: you move into a section and
   * nothing happens until you stop. The spec asks for once per *crossing*, which is what this
   * gives — immediate, and stable at the boundary.
   */
  hysteresisPx?: number
}

const DEFAULT_HYSTERESIS_PX = 12

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
  const { lineOffset, hysteresisPx = DEFAULT_HYSTERESIS_PX } = options

  const [activeKey, setActiveKey] = useState<K | null>(null)
  const elements = useRef(new Map<K, HTMLElement>())
  const frame = useRef<number | undefined>(undefined)
  const current = useRef<K | null>(null)

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

      /*
       * The deadzone. A section that is merely level with the line does not displace the current
       * one — it has to clear it by `hysteresisPx`. Sitting exactly on a boundary therefore holds
       * whatever is already showing instead of toggling on every stray pixel.
       */
      const threshold = key === current.current ? lineOffset + hysteresisPx : lineOffset

      if (rect.top <= threshold && rect.top > bestTop) {
        bestTop = rect.top
        found = key
      }
    }

    return found
  }, [keys, lineOffset, hysteresisPx])

  useEffect(() => {
    /*
     * Coalesced to one measurement per frame. Scroll fires far more often than the screen repaints,
     * and measuring more than once between paints is pure work for an identical answer.
     */
    const settle = (): void => {
      if (frame.current !== undefined) return

      frame.current = window.requestAnimationFrame(() => {
        frame.current = undefined
        const next = measure()
        if (next !== current.current) {
          current.current = next
          setActiveKey(next)
        }
      })
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
     * scrolling on iOS can end without a final intersection at all. Scroll drives a measurement of
     * its own so the active section tracks the page continuously rather than only at the moments
     * the observer happens to fire.
     */
    window.addEventListener('scroll', settle, { passive: true })
    window.addEventListener('resize', settle, { passive: true })

    // Establish the opening state without waiting for a scroll.
    settle()

    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', settle)
      window.removeEventListener('resize', settle)
      /*
       * Clearing the handle matters as much as cancelling it. `settle` treats a set `frame.current`
       * as "a measurement is already queued" and returns early, so a cancelled frame left recorded
       * here latches that guard closed permanently — the hook would go silent and never update
       * again. StrictMode's double-invoked mount effect hits this on the very first render.
       */
      if (frame.current !== undefined) {
        window.cancelAnimationFrame(frame.current)
        frame.current = undefined
      }
    }
  }, [keys, lineOffset, measure])

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
