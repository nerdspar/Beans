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

  it('ignores a destination the settings screen never offers', () => {
    // `settings` is not tabbable. Accepting it from a hand-edited preference would let someone put
    // it in the bottom bar, where it is deliberately not on offer.
    const order = keys(resolveNavigationOrder(['settings', 'portfolio']))
    expect(order[0]).toBe('portfolio')
    expect(order).toContain('settings')
  })

  it('falls back to the shipped default when nothing is stored', () => {
    expect(keys(resolveNavigationOrder(null)).slice(0, TAB_SLOTS)).toEqual([...DEFAULT_TAB_ORDER])
  })
})

describe('resolveTabOrder', () => {
  it('is the front of the navigation order', () => {
    // The property the whole change rests on. If these ever diverge, the setting means two things.
    for (const stored of [null, ['rules', 'portfolio'], ['portfolio', 'cash-flow', 'categories']]) {
      const tabs = keys(resolveTabOrder(stored))
      const fromOrder = keys(resolveNavigationOrder(stored).filter((d) => d.tabbable)).slice(
        0,
        TAB_SLOTS,
      )
      expect(tabs).toEqual(fromOrder)
    }
  })

  it('always yields exactly four, even from a short or empty preference', () => {
    // The fifth slot is More. Three tabs and a gap is not a state the bar can render.
    for (const stored of [null, [], ['portfolio'], ['portfolio', 'rules']]) {
      expect(resolveTabOrder(stored)).toHaveLength(TAB_SLOTS)
    }
  })

  it('never offers a destination that is not tabbable', () => {
    for (const destination of resolveTabOrder(['settings', 'import', 'household'])) {
      expect(destination.tabbable).toBe(true)
    }
  })
})
