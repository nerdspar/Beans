import {
  ArrowLeftRight,
  Banknote,
  ChartLine,
  Filter,
  PiggyBank,
  Settings,
  Tags,
  Upload,
  Users,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Every place you can navigate to, in one list.
 *
 * Both shells read from here — the mobile tab bar, the More sheet, and the desktop sidebar. A
 * destination added here appears everywhere it should without touching either shell, which is the
 * point: two navigation surfaces drifting apart is how a destination ends up reachable on desktop
 * and invisible on a phone.
 */

export type DestinationKey =
  | 'net-worth'
  | 'transactions'
  | 'cash-flow'
  | 'portfolio'
  | 'accounts'
  | 'categories'
  | 'rules'
  | 'import'
  | 'household'
  | 'settings'

export type Destination = {
  key: DestinationKey
  path: string
  /** Plain and legible. Wit belongs in empty and error states, never in something you navigate by. */
  label: string
  /**
   * The tab-bar label.
   *
   * A tab is about 70px wide, so "Transactions" truncates while "Activity" does not. Menus have the
   * room for the fuller name, and using one string for both means either the tab clips or the menu
   * reads tersely.
   */
  short: string
  icon: LucideIcon
  /**
   * Whether this may occupy one of the four configurable tab slots.
   *
   * Settings and the like are reachable from More and do not compete for a slot — a thumb-sized
   * target is scarce, and spending one on something visited twice a year is a poor trade.
   */
  tabbable: boolean
}

export const DESTINATIONS: readonly Destination[] = [
  {
    key: 'net-worth',
    path: '/',
    label: 'Net worth',
    short: 'Net worth',
    icon: ChartLine,
    tabbable: true,
  },
  {
    key: 'transactions',
    path: '/transactions',
    label: 'Transactions',
    short: 'Activity',
    icon: ArrowLeftRight,
    tabbable: true,
  },
  {
    key: 'cash-flow',
    path: '/cash-flow',
    label: 'Cash flow',
    short: 'Cash flow',
    icon: Banknote,
    tabbable: true,
  },
  {
    key: 'portfolio',
    path: '/portfolio',
    label: 'Portfolio',
    short: 'Portfolio',
    icon: PiggyBank,
    tabbable: true,
  },
  /**
   * Deliberately **not** a browse destination.
   *
   * The net worth screen is already the account list — every account, grouped by section, with
   * balances and sync status. A second top-level list of the same accounts would be two surfaces
   * rendering the same data, free to drift, and would spend one of four scarce tab slots on a copy
   * of the list the user is already looking at. Account details are reached by tapping a row there.
   *
   * What lives here instead is everything net worth deliberately does not show: adding and editing
   * manual accounts, closed accounts, accounts a member has marked private, and per-account
   * settings like tax treatment. Management, not browsing — which is settings-shaped, so it sits in
   * More rather than competing for a tab.
   */
  {
    key: 'accounts',
    path: '/accounts',
    label: 'Manage accounts',
    short: 'Accounts',
    icon: Wallet,
    tabbable: false,
  },
  /*
   * Categories, rules, import and the household are **destinations**, not settings.
   *
   * They were folded into the settings page as expanding sections, which was the wrong shape twice
   * over. Each is a screen's worth of interface stuffed into a list row, so opening one shoved
   * everything below it down the page; and none of them had a URL, so there was no linking to one,
   * no back button, and a reload dropped you at the top.
   *
   * As destinations they get their own address, the shells route to them for free, and the two
   * things left in settings — the tab bar and one toggle — are finally the only things in it.
   *
   * Categories and rules are `tabbable`: a household deep in cleaning up a year of transactions may
   * genuinely want one in the bar, and the whole point of configurable tabs is not deciding that on
   * their behalf. Import and household are not — a one-off task and a setup step do not compete for
   * a thumb-sized target, which is the same reasoning as `accounts` above.
   */
  {
    key: 'categories',
    path: '/categories',
    label: 'Categories',
    short: 'Categories',
    icon: Tags,
    tabbable: true,
  },
  {
    key: 'rules',
    path: '/rules',
    label: 'Rules',
    short: 'Rules',
    icon: Filter,
    tabbable: true,
  },
  {
    key: 'import',
    path: '/import',
    label: 'Import data',
    short: 'Import',
    icon: Upload,
    tabbable: false,
  },
  {
    key: 'household',
    path: '/household',
    label: 'Household',
    short: 'Household',
    icon: Users,
    tabbable: false,
  },
  {
    key: 'settings',
    path: '/settings',
    label: 'Settings',
    short: 'Settings',
    icon: Settings,
    tabbable: false,
  },
]

/**
 * The four configurable slots, before the user changes anything.
 *
 * Net worth first because it is the screen this app exists for.
 */
export const DEFAULT_TAB_ORDER: readonly DestinationKey[] = [
  'net-worth',
  'transactions',
  'cash-flow',
  'portfolio',
]

/** Exactly four. The fifth slot is always More, so it is not configurable. */
export const TAB_SLOTS = 4

const BY_KEY = new Map(DESTINATIONS.map((destination) => [destination.key, destination]))

export function findDestination(key: DestinationKey): Destination | undefined {
  return BY_KEY.get(key)
}

export function tabbableDestinations(): Destination[] {
  return DESTINATIONS.filter((destination) => destination.tabbable)
}

/**
 * Every destination, in the order the reader chose.
 *
 * **One order, two shells.** The preference used to reach only the phone: the desktop sidebar
 * rendered `DESTINATIONS` directly and ignored it, so someone who reordered their navigation found
 * it unchanged on a laptop — a setting that silently did nothing on half the app.
 *
 * The chosen keys come first, then anything the choice did not cover. The phone takes the first
 * four of these; the sidebar shows all of them. That coupling is deliberate: promoting something to
 * the top of the sidebar is the same intent as wanting it on the bottom bar, and expressing it
 * twice is how two lists drift apart.
 *
 * Deliberately forgiving: a stored key that no longer exists, a list of the wrong length, or an
 * unparseable value all fall back to the default rather than erroring. A navigation bar is the
 * wrong place to surface a data problem — an app that will not render its own chrome because a
 * preference is stale is worse than one quietly showing the defaults.
 */
export function resolveNavigationOrder(stored: readonly string[] | null | undefined): Destination[] {
  const resolved: Destination[] = []
  const seen = new Set<DestinationKey>()

  const take = (destination: Destination | undefined): void => {
    if (destination === undefined || seen.has(destination.key)) return
    resolved.push(destination)
    seen.add(destination.key)
  }

  // What the reader asked for. Only tabbable destinations are offered by the settings screen, so
  // anything else appearing here is a stale or hand-edited value and is skipped.
  for (const key of stored ?? []) {
    const destination = BY_KEY.get(key as DestinationKey)
    if (destination?.tabbable === true) take(destination)
  }

  // Top up from the default order, so a short or partly-invalid preference still yields four tabs.
  for (const key of DEFAULT_TAB_ORDER) take(BY_KEY.get(key))

  // Then everything the choice did not cover, in the order this file declares them. These are the
  // destinations the settings screen does not offer — they have a place in the sidebar regardless.
  for (const destination of DESTINATIONS) take(destination)

  return resolved
}

/**
 * The four bottom tabs, which are simply the front of the navigation order.
 *
 * Derived rather than resolved separately, so the bar and the sidebar cannot disagree about what
 * the reader chose.
 */
export function resolveTabOrder(stored: readonly string[] | null | undefined): Destination[] {
  return resolveNavigationOrder(stored)
    .filter((destination) => destination.tabbable)
    .slice(0, TAB_SLOTS)
}

/** Everything not in the tab bar, for the More sheet. Order follows DESTINATIONS. */
export function overflowDestinations(tabs: readonly Destination[]): Destination[] {
  const inTabs = new Set(tabs.map((tab) => tab.key))
  return DESTINATIONS.filter((destination) => !inTabs.has(destination.key))
}

/**
 * The destination a path belongs to.
 *
 * Longest-prefix match, so `/accounts/abc` highlights Accounts rather than falling through to the
 * root. The root is matched exactly, or it would claim every path.
 */
export function destinationForPath(path: string): Destination | undefined {
  let best: Destination | undefined
  for (const destination of DESTINATIONS) {
    if (destination.path === '/') {
      if (path === '/') best = destination
      continue
    }
    if (path === destination.path || path.startsWith(`${destination.path}/`)) {
      if (best === undefined || destination.path.length > best.path.length) {
        best = destination
      }
    }
  }
  return best
}
