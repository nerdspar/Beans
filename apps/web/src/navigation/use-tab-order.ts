import { usePreferences } from '../preferences/use-preferences.js'
import {
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
 *
 * The fetch and the optimistic patch live in `use-preferences.ts`, shared with every other setting.
 * Two hooks each owning their own copy of the same row is how one of them ends up overwriting the
 * other's field on save.
 */
export function useTabOrder(): {
  tabs: Destination[]
  setTabOrder: (keys: DestinationKey[]) => void
  resetTabOrder: () => void
  isSaving: boolean
} {
  const { preferences, patch, isSaving } = usePreferences()

  return {
    tabs: resolveTabOrder(preferences.tabOrder),
    setTabOrder: (keys) => patch({ tabOrder: keys }),
    // Null rather than the default array: storing null means "no preference", so a later change to
    // the shipped default reaches people who never customized it.
    resetTabOrder: () => patch({ tabOrder: null }),
    isSaving,
  }
}
