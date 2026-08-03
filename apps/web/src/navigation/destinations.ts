import {
  ArrowLeftRight,
  Banknote,
  ChartLine,
  CreditCard,
  Landmark,
  PiggyBank,
  Settings,
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
  | 'household'
  | 'connections'
  | 'import'
  | 'categories'
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
  {
    key: 'household',
    path: '/household',
    label: 'Household',
    short: 'Household',
    icon: Users,
    tabbable: false,
  },
  {
    key: 'connections',
    path: '/connections',
    label: 'Connections',
    short: 'Banks',
    icon: Landmark,
    // Tabbable: sync health is worth glancing at often when a connection is flaky, and it gives
    // the tab chooser a fifth option so there is a real choice to make.
    tabbable: true,
  },
  {
    key: 'import',
    path: '/import',
    label: 'Import',
    short: 'Import',
    icon: Upload,
    tabbable: false,
  },
  {
    key: 'categories',
    path: '/categories',
    label: 'Categories',
    short: 'Categories',
    icon: CreditCard,
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
 * Resolves a stored preference into four destinations.
 *
 * Deliberately forgiving: a stored key that no longer exists, a list of the wrong length, or an
 * unparseable value all fall back to the default rather than erroring. A navigation bar is the
 * wrong place to surface a data problem — an app that will not render its own chrome because a
 * preference is stale is worse than one quietly showing the defaults.
 */
export function resolveTabOrder(stored: readonly string[] | null | undefined): Destination[] {
  const resolved: Destination[] = []
  const seen = new Set<DestinationKey>()

  for (const key of stored ?? []) {
    const destination = BY_KEY.get(key as DestinationKey)
    if (destination !== undefined && destination.tabbable && !seen.has(destination.key)) {
      resolved.push(destination)
      seen.add(destination.key)
    }
    if (resolved.length === TAB_SLOTS) break
  }

  // Top up from the default order, so a short or partly-invalid preference still yields four tabs.
  for (const key of DEFAULT_TAB_ORDER) {
    if (resolved.length === TAB_SLOTS) break
    const destination = BY_KEY.get(key)
    if (destination !== undefined && !seen.has(key)) {
      resolved.push(destination)
      seen.add(key)
    }
  }

  return resolved
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
