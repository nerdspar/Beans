import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_TAB_ORDER,
  resolveTabOrder,
  type Destination,
  type DestinationKey,
} from './destinations.js'

/**
 * The user's chosen bottom tabs.
 *
 * Persisted **server-side, per user**, so the choice follows them across devices rather than living
 * in one browser's storage. Someone who reorders their tabs on a phone should find the same layout
 * on a laptop; localStorage cannot do that, and syncing it later would mean reconciling two
 * sources.
 */

type Preferences = { tabOrder: string[] | null }

async function fetchPreferences(): Promise<Preferences> {
  const response = await fetch('/api/preferences', { credentials: 'same-origin' })
  if (!response.ok) {
    // Not signed in, or the endpoint is unavailable. Defaults are a fine answer for chrome.
    return { tabOrder: null }
  }
  return (await response.json()) as Preferences
}

export function useTabOrder(): {
  tabs: Destination[]
  setTabOrder: (keys: DestinationKey[]) => void
  resetTabOrder: () => void
  isSaving: boolean
} {
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['preferences'],
    queryFn: fetchPreferences,
    // Chrome should never flash. Serving the previous value while revalidating keeps the tab bar
    // stable across navigations.
    staleTime: 5 * 60 * 1000,
  })

  const mutation = useMutation({
    mutationFn: async (tabOrder: string[] | null) => {
      await fetch('/api/preferences', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabOrder }),
      })
    },
    /**
     * Applied optimistically. Reordering tabs is a direct manipulation — the bar should move under
     * the user's finger, not after a round trip.
     */
    onMutate: async (tabOrder) => {
      await queryClient.cancelQueries({ queryKey: ['preferences'] })
      const previous = queryClient.getQueryData<Preferences>(['preferences'])
      queryClient.setQueryData<Preferences>(['preferences'], { tabOrder })
      return { previous }
    },
    onError: (_error, _variables, context) => {
      // Put it back rather than leaving the UI claiming something the server did not accept.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['preferences'], context.previous)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['preferences'] })
    },
  })

  return {
    tabs: resolveTabOrder(data?.tabOrder),
    setTabOrder: (keys) => mutation.mutate(keys),
    // Null rather than the default array: storing null means "no preference", so a later change to
    // the shipped default reaches people who never customized it.
    resetTabOrder: () => mutation.mutate(null),
    isSaving: mutation.isPending,
  }
}

export { DEFAULT_TAB_ORDER }
