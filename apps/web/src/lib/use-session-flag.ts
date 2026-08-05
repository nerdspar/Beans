import { useCallback, useState } from 'react'

/**
 * A boolean that survives navigation but not a new session.
 *
 * For preferences that should hold while somebody works and reset next time they arrive — a panel
 * collapsed to get it out of the way is a decision about this visit, not a standing choice, and
 * making it permanent would hide something the next visit may need to see.
 *
 * `sessionStorage` rather than the preferences table: this is per-tab and disposable, and a round
 * trip to store it would make a collapse animate late. It survives the full page loads sign-in and
 * sign-out perform, and dies with the tab.
 */
export function useSessionFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === 'undefined') return fallback
    try {
      const stored = window.sessionStorage.getItem(key)
      return stored === null ? fallback : stored === 'true'
    } catch {
      // Private browsing can refuse storage. The default is a fine answer.
      return fallback
    }
  })

  const set = useCallback(
    (next: boolean): void => {
      setValue(next)
      try {
        window.sessionStorage.setItem(key, String(next))
      } catch {
        // Nothing to do; the value still holds for this render tree's lifetime.
      }
    },
    [key],
  )

  return [value, set]
}
