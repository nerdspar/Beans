import { MAX_TAB_ORDER_LENGTH } from '@beans/shared'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAB_ORDER,
  DESTINATIONS,
  TAB_SLOTS,
  resolveNavigationOrder,
  resolveTabOrder,
} from './destinations.js'

/**
 * One stored preference, two shells.
 *
 * The bar and the sidebar are now the same list read to different depths, and these pin the two
 * properties that keeps honest: the phone shows the front of what the sidebar shows, and the
 * sidebar shows everything. A reader who promotes something on one device must find it promoted on
 * the other, and neither may lose a destination — a navigation list that silently drops an entry is
 * a screen nobody can reach.
 */

const keys = (list: readonly { key: string }[]): string[] => list.map((item) => item.key)

it('has fewer destinations than the API will accept in one order', () => {
  /*
   * The tripwire for the bug that made this list unsavable.
   *
   * The settings screen sends the whole order, so the API's cap has to exceed the number of
   * destinations. It did not: the cap was eight, chosen when only six were offered, and the tenth
   * destination made every save a silent 400. Adding destinations is routine and noticing a limit
   * in another package is not, so the limit is shared and this fails the moment they cross.
   */
  expect(DESTINATIONS.length).toBeLessThanOrEqual(MAX_TAB_ORDER_LENGTH)
})

describe('resolveNavigationOrder', () => {
  it('lists every destination exactly once, whatever is stored', () => {
    for (const stored of [null, undefined, [], ['rules'], ['nonsense', 'rules', 'rules']]) {
      const order = resolveNavigationOrder(stored)
      expect(order).toHaveLength(DESTINATIONS.length)
      expect(new Set(keys(order)).size).toBe(DESTINATIONS.length)
    }
  })

  it('puts the chosen destinations first, in the order given', () => {
    const order = keys(resolveNavigationOrder(['portfolio', 'rules', 'cash-flow']))
    expect(order.slice(0, 3)).toEqual(['portfolio', 'rules', 'cash-flow'])
  })

  it('ignores keys that do not exist, rather than erroring', () => {
    // A preference outliving a renamed destination must not stop the app rendering its own chrome.
    const order = keys(resolveNavigationOrder(['ghost', 'portfolio', 'also-gone']))
    expect(order[0]).toBe('portfolio')
    expect(order).not.toContain('ghost')
  })

  it('orders any destination, including ones that were once barred from the tab bar', () => {
    // There is no longer a set that may not be a tab. The default still puts the four browsing
    // screens first; wanting Settings at the top is a choice, not a mistake to be prevented.
    const order = keys(resolveNavigationOrder(['settings', 'portfolio']))
    expect(order.slice(0, 2)).toEqual(['settings', 'portfolio'])
  })

  it('falls back to the shipped default when nothing is stored', () => {
    expect(keys(resolveNavigationOrder(null)).slice(0, TAB_SLOTS)).toEqual([...DEFAULT_TAB_ORDER])
  })
})

describe('resolveTabOrder', () => {
  it('is the front of the navigation order', () => {
    // The property the whole change rests on. If these ever diverge, the setting means two things.
    for (const stored of [null, ['rules', 'portfolio'], ['settings', 'accounts', 'categories']]) {
      expect(keys(resolveTabOrder(stored))).toEqual(
        keys(resolveNavigationOrder(stored)).slice(0, TAB_SLOTS),
      )
    }
  })

  it('always yields exactly four, even from a short or empty preference', () => {
    // The fifth slot is More. Three tabs and a gap is not a state the bar can render.
    for (const stored of [null, [], ['portfolio'], ['portfolio', 'rules']]) {
      expect(resolveTabOrder(stored)).toHaveLength(TAB_SLOTS)
    }
  })

  it('puts whatever the reader chose in the bar, with no destination held back', () => {
    // Settings, Accounts and Household were once refused a slot on their behalf. Somebody who wants
    // Manage accounts under their thumb is not making a mistake.
    expect(keys(resolveTabOrder(['settings', 'accounts', 'household', 'rules']))).toEqual([
      'settings',
      'accounts',
      'household',
      'rules',
    ])
  })
})
