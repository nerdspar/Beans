import { useMutation, useQuery } from '@tanstack/react-query'
import { clearWorkingSet } from '../working-set/db.js'

/**
 * The signed-in user, and the ways in and out.
 *
 * **Signing out clears the working set** (ARCHITECTURE.md §7.4). IndexedDB holds the household's
 * decrypted finances in plaintext in the browser profile — that was a knowing tradeoff, but it is
 * only defensible if the data leaves when the session does. Leaving it behind would mean a shared
 * or borrowed device keeps a full copy of someone's balances after they have signed out, which is
 * not what signing out means to anybody.
 */

export type SessionUser = { id: string; email: string; name: string }

export const SESSION_KEY = ['session'] as const
export const CAPABILITIES_KEY = ['capabilities'] as const

async function fetchSession(): Promise<SessionUser | null> {
  const response = await fetch('/api/auth/get-session', { credentials: 'same-origin' })
  if (!response.ok) return null

  // Better Auth answers 200 with an empty body for "no session", so an unparseable body here is the
  // normal signed-out case rather than a failure.
  const text = await response.text()
  if (text.trim().length === 0) return null

  const body = JSON.parse(text) as { user?: SessionUser } | null
  return body?.user ?? null
}

export type Capabilities = {
  googleSignIn: boolean
  emailSignIn: boolean
  /** Absent unless the deployment configured a demo account. Off is the default everywhere. */
  demoSignIn: boolean
}

export function useCapabilities(): Capabilities {
  const query = useQuery({
    queryKey: CAPABILITIES_KEY,
    queryFn: async (): Promise<Capabilities> => {
      const response = await fetch('/api/capabilities', { credentials: 'same-origin' })
      if (!response.ok) throw new Error('Could not read capabilities')
      return (await response.json()) as Capabilities
    },
    // Fixed per deployment. Refetching it is pure waste.
    staleTime: Infinity,
  })

  // Email sign-in is always available; assuming it while the answer is in flight avoids a sign-in
  // form that flickers into existence.
  return query.data ?? { googleSignIn: false, emailSignIn: true, demoSignIn: false }
}

export function useSession(): {
  user: SessionUser | null
  isLoading: boolean
} {
  const query = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 30 * 1000 })
  return { user: query.data ?? null, isLoading: query.isLoading }
}

export function useSignOut(): { signOut: () => void; isPending: boolean } {

  const mutation = useMutation({
    /*
     * Every step lives in the mutation function, and none in `onSuccess`/`onSettled`.
     *
     * Those callbacks belong to the component's observer, and React Query skips them when the
     * component unmounts before the mutation resolves — which is exactly what happens here, because
     * signing out closes the sheet that owns this hook. The first version cleared IndexedDB (inside
     * the function, so it ran) but never cleared the query cache (in `onSettled`, so it did not),
     * and the previous user's balances stayed on screen after a successful sign-out.
     */
    mutationFn: async () => {
      await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' })

      /*
       * Cleared after the request but unconditionally — a sign-out that fails server-side still has
       * to leave nothing behind locally, because the person in front of the device has already
       * walked away from it.
       */
      await clearWorkingSet()

      /*
       * A full reload rather than cache invalidation.
       *
       * Emptying the query cache and letting the session refetch *should* be enough, and it is the
       * tidier thing to write — but it leaves the decision of what survives to React Query's
       * lifecycle rules, and the first version of this hook already lost that argument once: its
       * cleanup lived in `onSettled`, the sheet unmounted, the callback was skipped, and the
       * previous user's balances stayed on screen after a successful sign-out.
       *
       * A reload is not a fallback for that bug, it is the stronger guarantee. Nothing decrypted
       * survives in a variable, a closure, or a cache — the tab starts over with no session. For an
       * app whose whole storage argument is "the plaintext leaves when the session does", the
       * blunt instrument is the correct one.
       */
      window.location.assign('/')
    },
  })

  return { signOut: () => mutation.mutate(), isPending: mutation.isPending }
}
