import { useSearch } from 'wouter'

/**
 * Where "back" goes, when a screen can be reached from more than one place.
 *
 * ## The problem this solves
 *
 * Account detail and holding detail link to each other. An account lists the positions inside it;
 * a position lists the accounts holding it. That is the right shape — each is the other's natural
 * next question — and it means either screen can be arrived at from the other, from the portfolio,
 * or from a cold deep link.
 *
 * A hardcoded back link cannot serve that. Holding detail sending you to the portfolio when you
 * arrived from an account is not merely imprecise: it drops you somewhere you were not, and the
 * only way back to the account is to navigate down through it again. Two screens that link to each
 * other, each with a fixed exit, is exactly how a person ends up circling.
 *
 * ## Why the URL and not history
 *
 * `history.back()` is the honest answer for a browser tab and the wrong one here. Installed as a PWA
 * there is no browser chrome, so this control is the *only* way back, and it has to be able to name
 * its destination — an unlabelled arrow in a two-screen cycle tells you nothing about which of them
 * you are about to land on. A path in the query string survives a reload and a cold start, which
 * `history` state does not.
 *
 * Each link carries exactly one level. Chains unwind a step at a time and terminate at the screen's
 * own fallback, so there is no state to grow and nothing to get stuck in.
 */

export type BackTarget = {
  href: string
  label: string
}

/**
 * Adds the current screen to a link, so the destination knows where it was opened from.
 *
 * The label travels with the path deliberately. Deriving it at the far end would mean holding
 * detail knowing how to name an account, which needs the working set for a string — and would
 * still be a guess for anything reached from outside.
 */
export function withReturn(href: string, from: BackTarget): string {
  const query = new URLSearchParams({ from: from.href, fromLabel: from.label })
  return `${href}?${query.toString()}`
}

/**
 * The back target for this screen: wherever it was opened from, or its own fallback.
 *
 * The fallback is what a deep link, a bookmark or a shared URL gets. It is never wrong, only less
 * specific than the caller might have liked.
 */
export function useBackTarget(fallback: BackTarget): BackTarget {
  return resolveBackTarget(useSearch(), fallback)
}

/**
 * The back target encoded in a query string, or the fallback.
 *
 * **Only same-origin absolute paths are honoured.** `from` arrives in a URL, which means it can be
 * handed to somebody in a link. Following it blindly would let that link render a Beans back button
 * pointing anywhere — the small, dull version of an open redirect, and worse here than usual
 * because the control is styled as the app's own navigation and carries the app's own label.
 *
 * A leading `//` is rejected alongside schemes: `//example.com` is protocol-relative and navigates
 * off-site despite passing a naive "starts with a slash" check.
 */
export function resolveBackTarget(search: string, fallback: BackTarget): BackTarget {
  const params = new URLSearchParams(search)

  const href = params.get('from')
  const label = params.get('fromLabel')

  if (href === null || !href.startsWith('/') || href.startsWith('//')) {
    return fallback
  }

  return { href, label: label === null || label.trim() === '' ? fallback.label : label }
}
