import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Per-user interface preferences, stored server-side.
 *
 * Keyed to the person rather than the browser so choices follow them across devices — see
 * `apps/api/src/routes/preferences.ts`. This module owns the query and the patch; the hooks that
 * expose individual settings build on it rather than each fetching their own copy.
 */

export const PREFERENCES_KEY = ['preferences'] as const

export type Preferences = {
  tabOrder: string[] | null
  theme: 'light' | 'dark' | 'system'
  /** Whether net worth is drawn back to the earliest account, or only where every account reaches. */
  showIncompleteHistory: boolean
}

/**
 * What an unauthenticated or unreachable server implies.
 *
 * Chrome renders for signed-out users too, and defaults are a fine answer there — better than a
 * blank tab bar while a request that will fail is in flight.
 */
const FALLBACK: Preferences = { tabOrder: null, theme: 'system', showIncompleteHistory: true }

async function fetchPreferences(): Promise<Preferences> {
  const response = await fetch('/api/preferences', { credentials: 'same-origin' })
  if (!response.ok) return FALLBACK

  const body = (await response.json()) as Partial<Preferences>
  return { ...FALLBACK, ...body }
}

/** Only the keys sent are changed. `tabOrder: null` clears it; omitting it leaves it alone. */
export type PreferencePatch = Partial<Preferences>

export function usePreferences(): {
  preferences: Preferences
  patch: (changes: PreferencePatch) => void
  isSaving: boolean
} {
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: fetchPreferences,
    // Chrome should never flash. Serving the previous value while revalidating keeps the tab bar
    // and the settings screen stable across navigations.
    staleTime: 5 * 60 * 1000,
  })

  const mutation = useMutation({
    mutationFn: async (changes: PreferencePatch) => {
      await fetch('/api/preferences', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
    },

    /**
     * Applied optimistically. These are direct manipulations — a tab bar should move under the
     * user's finger and a switch should flip when pressed, not after a round trip.
     */
    onMutate: async (changes) => {
      await queryClient.cancelQueries({ queryKey: PREFERENCES_KEY })
      const previous = queryClient.getQueryData<Preferences>(PREFERENCES_KEY)
      queryClient.setQueryData<Preferences>(PREFERENCES_KEY, {
        ...(previous ?? FALLBACK),
        ...changes,
      })
      return { previous }
    },

    onError: (_error, _changes, context) => {
      // Put it back rather than leaving the UI claiming something the server did not accept.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PREFERENCES_KEY, context.previous)
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY })
    },
  })

  return {
    preferences: data ?? FALLBACK,
    patch: (changes) => mutation.mutate(changes),
    isSaving: mutation.isPending,
  }
}
