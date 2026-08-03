import { useSyncExternalStore } from 'react'

/**
 * Which shell to render.
 *
 * The breakpoint is evaluated **synchronously on first render**, not in an effect. In a
 * client-rendered SPA `matchMedia` is available before the first paint, so reading it in an effect
 * would render the wrong shell once and then swap — a visible reshuffle of the entire navigation
 * chrome on every cold load.
 *
 * `useSyncExternalStore` is what makes that safe: its `getSnapshot` runs during render, and the
 * subscription keeps it correct when the window is resized or a tablet is rotated.
 */

/** Tailwind's `md`. Below it, thumbs; above it, a pointer and room for a sidebar. */
const DESKTOP_QUERY = '(min-width: 768px)'

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY)
  media.addEventListener('change', onChange)
  return () => {
    media.removeEventListener('change', onChange)
  }
}

function getSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches
}

/**
 * Server snapshot, for a future SSR build. Defaults to mobile: it is the more constrained layout,
 * so getting it wrong degrades more gracefully than the reverse.
 */
function getServerSnapshot(): boolean {
  return false
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
