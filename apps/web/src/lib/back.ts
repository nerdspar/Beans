import { useLocation, useSearch } from 'wouter'

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
 * only way back to the account is to navigate down through it again.
 *
 * ## Why the URL and not history
 *
 * `history.back()` is the honest answer for a browser tab and the wrong one here. Installed as a PWA
 * there is no browser chrome, so this control is the *only* way back, and it has to be able to name
 * its destination — an unlabelled arrow in a two-screen cycle tells you nothing about which of them
 * you are about to land on. A path in the query string survives a reload and a cold start, which
 * `history` state does not.
 *
 * ## The chain
 *
 * A link carries the **whole** path that led to it, nested. Portfolio → account → holding → back →
 * account → back lands on the portfolio, not on the account's generic fallback. Carrying only the
 * immediate parent was the first attempt and it loses exactly the case worth having: the screen you
 * came *through* is the one you least want to be dropped from.
 *
 * Nesting encodes each URL inside the next, so length grows with every step. That is what
 * {@link MAX_RETURN_LENGTH} bounds — past it the ancestry is dropped and the link keeps only its
 * immediate parent, which degrades to the old behaviour instead of producing a URL a browser will
 * refuse.
 */

export type BackTarget = {
  href: string
  label: string
}

/**
 * How long a link carrying its ancestry may get, in characters.
 *
 * Well under any browser's limit, and generous enough for the four or five levels a person actually
 * walks. The bound is on the finished link rather than on a depth count because length is the thing
 * that actually breaks.
 */
const MAX_RETURN_LENGTH = 1500

/**
 * Adds the current screen to a link, so the destination knows where it was opened from.
 *
 * The label travels with the path deliberately. Deriving it at the far end would mean holding
 * detail knowing how to name an account, which needs the working set for a string — and would
 * still be a guess for anything reached from outside.
 */
export function withReturn(href: string, from: BackTarget): string {
  const full = link(href, from.href, from.label)
  if (full.length <= MAX_RETURN_LENGTH) return full

  // Too deep to carry the whole path. Keep the immediate parent, drop what led to it.
  return link(href, stripAncestry(from.href), from.label)
}

/**
 * Merges the return target into the link, rather than appending a second `?`.
 *
 * The targets in this app are all bare paths today, so this looks like belt and braces — it is not.
 * `/portfolio?group=holding` is already a link one of these screens produces, and appending to it
 * blindly would yield a URL with two query strings that parses as neither.
 */
function link(href: string, fromHref: string, label: string): string {
  const [path = href, existing = ''] = href.split('?')

  const params = new URLSearchParams(existing)
  params.set('from', fromHref)
  params.set('fromLabel', label)

  return `${path}?${params.toString()}`
}

function stripAncestry(href: string): string {
  const index = href.indexOf('?')
  return index === -1 ? href : href.slice(0, index)
}

/**
 * The back target for this screen: wherever it was opened from, or its own fallback.
 *
 * The fallback is what a deep link, a bookmark or a shared URL gets. It is never wrong, only less
 * specific than the caller might have liked.
 */
export function useBackTarget(fallback: BackTarget): BackTarget {
  return resolveBackTarget(useRawSearch(), fallback)
}

/** This screen, addressed exactly as it currently is, for handing to {@link withReturn}. */
export function useHere(label: string): BackTarget {
  const [pathname] = useLocation()
  const search = useRawSearch()

  return { href: search === '' ? pathname : `${pathname}?${search}`, label }
}

/**
 * The query string as it actually appears in the address bar.
 *
 * **Not `useSearch()`, and this is not a style preference.** wouter runs its search through
 * `unescape()` before handing it over, so what comes back is percent-*decoded*. A nested `from`
 * chain then splits at the first `&` it contains, and any label with an ampersand in it — an
 * account called "Stocks & Shares" — loses everything after it. Both were silently truncating.
 *
 * `useSearch()` is still called, for its subscription: it is what re-renders this component when
 * the query changes, which matters because the portfolio's grouping toggle changes the search
 * without touching the path. Subscribe through wouter, read the value from the browser.
 */
function useRawSearch(): string {
  useSearch()
  return typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '')
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
