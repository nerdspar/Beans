import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The rendered height of an element, kept current as it changes.
 *
 * For stacking one pinned block beneath another. The lower block's `top` has to equal the upper
 * block's height, and that height is not a constant — a collapsible panel above it changes it, and
 * so does a wrapped line at a narrower width. Hard-coding the offset means the two blocks overlap
 * or leave a gap the moment anything above resizes.
 */
export function useMeasuredHeight(): [(node: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(0)
  const observed = useRef<HTMLElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect()
    observed.current = node

    if (node === null) {
      setHeight(0)
      return
    }

    setHeight(node.getBoundingClientRect().height)

    /*
     * Observed rather than measured once. The panel above collapses, the range control rewraps, the
     * caveat count changes — each moves this by tens of pixels, and a stale offset shows as the
     * lower block sitting under the upper one or floating below it.
     */
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setHeight(entry.contentRect.height + borderAndPadding(node))
    })
    observer.current.observe(node)
  }, [])

  useEffect(() => () => observer.current?.disconnect(), [])

  return [ref, height]
}

/** `contentRect` excludes padding and border; the offset needs the full box. */
function borderAndPadding(node: HTMLElement): number {
  const style = getComputedStyle(node)
  return (
    Number.parseFloat(style.paddingTop) +
    Number.parseFloat(style.paddingBottom) +
    Number.parseFloat(style.borderTopWidth) +
    Number.parseFloat(style.borderBottomWidth)
  )
}
