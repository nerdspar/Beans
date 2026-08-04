/**
 * Holding an invite token across sign-up.
 *
 * An invite link is `/join/<token>`, and opening it while signed out lands on the sign-in screen.
 * Sign-in then does a **full page load to `/`** — the same reload sign-out does, so no stale
 * balances survive — which means React state cannot carry the token and the path is gone by the
 * time a session exists. Nothing consumed the token at all, so accepting an invite was impossible:
 * the link produced an account in no household.
 *
 * So it is lifted out of the URL the moment the app starts and parked in `sessionStorage`, which
 * survives a reload and dies with the tab.
 */

const STORAGE_KEY = 'beans.pending-invite'

/** Base64url, as issued. Anything else is not a token and is not worth storing. */
const JOIN_PATH = /^\/join\/([A-Za-z0-9_-]{16,256})\/?$/

/**
 * Called once at startup, before anything routes.
 *
 * The token is **removed from the URL** as soon as it is stored. It is a single-use credential, and
 * leaving it in the address bar puts it in browser history, in any screenshot of the window, and in
 * the `Referer` of the next outbound request.
 */
export function capturePendingInvite(): void {
  if (typeof window === 'undefined') return

  const token = JOIN_PATH.exec(window.location.pathname)?.[1]
  if (token === undefined) return

  try {
    window.sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    // Private browsing can refuse storage. The token stays in the URL in that case, which still
    // works for an already-signed-in user and is better than throwing during startup.
    return
  }

  window.history.replaceState(null, '', '/')
}

export function readPendingInvite(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function clearPendingInvite(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do — a token that cannot be cleared expires on its own and is single-use.
  }
}
