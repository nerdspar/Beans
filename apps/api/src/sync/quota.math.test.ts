import { describe, expect, it } from 'vitest'
import {
  DAILY_REQUEST_BUDGET,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  RESERVED_FOR_SCHEDULED,
  backoffMs,
  canSync,
  jitterForSchedule,
  syncWindowStart,
  type ConnectionSyncState,
} from './quota.js'

// Fixed clock. Never the wall clock (CLAUDE.md).
const NOW = new Date('2026-08-03T14:30:00.000Z')

const healthy: ConnectionSyncState = {
  requestsToday: 0,
  lastAttemptAt: null,
  consecutiveFailures: 0,
}

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs)
const minutes = (n: number): number => n * 60 * 1000
const hours = (n: number): number => n * 60 * minutes(1)

describe('daily request budget', () => {
  it('allows a scheduled sync with budget remaining', () => {
    expect(canSync(healthy, 'scheduled', NOW).allowed).toBe(true)
  })

  it('refuses everything once the budget is exhausted', () => {
    const spent = { ...healthy, requestsToday: DAILY_REQUEST_BUDGET }

    for (const trigger of ['scheduled', 'manual'] as const) {
      const decision = canSync(spent, trigger, NOW)
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.reason).toMatch(/budget/)
        // Resets at UTC midnight, not 24h from now.
        expect(decision.retryAfter?.toISOString()).toBe('2026-08-04T00:00:00.000Z')
      }
    }
  })

  /**
   * The reason the reserve exists: a user hammering refresh must not be able to starve the
   * scheduled sync. Losing a manual refresh is an inconvenience; losing the scheduled one means the
   * numbers quietly stop updating, which is this app's worst failure mode.
   */
  it('reserves the tail of the budget for scheduled syncs', () => {
    const nearlySpent = {
      ...healthy,
      requestsToday: DAILY_REQUEST_BUDGET - RESERVED_FOR_SCHEDULED,
    }

    const manual = canSync(nearlySpent, 'manual', NOW)
    expect(manual.allowed).toBe(false)
    if (!manual.allowed) {
      expect(manual.reason).toMatch(/reserved for scheduled/)
    }

    // ...but the scheduled sync still runs.
    expect(canSync(nearlySpent, 'scheduled', NOW).allowed).toBe(true)
  })

  it('allows a manual refresh just below the reserve', () => {
    const state = {
      ...healthy,
      requestsToday: DAILY_REQUEST_BUDGET - RESERVED_FOR_SCHEDULED - 1,
    }
    expect(canSync(state, 'manual', NOW).allowed).toBe(true)
  })

  it('leaves room for every scheduled sync of the day', () => {
    // Four scheduled syncs must fit inside the reserve, with margin for a retry or two.
    expect(RESERVED_FOR_SCHEDULED).toBeGreaterThanOrEqual(4)
    expect(RESERVED_FOR_SCHEDULED).toBeLessThan(DAILY_REQUEST_BUDGET)
  })
})

describe('backoff after failures', () => {
  it('is zero when healthy', () => {
    expect(backoffMs(0)).toBe(0)
  })

  it('grows exponentially', () => {
    expect(backoffMs(1)).toBe(minutes(15))
    expect(backoffMs(2)).toBe(minutes(30))
    expect(backoffMs(3)).toBe(hours(1))
    expect(backoffMs(4)).toBe(hours(2))
  })

  it('caps rather than growing without bound', () => {
    expect(backoffMs(10)).toBe(hours(6))
    expect(backoffMs(1000)).toBe(hours(6))
  })

  it('does not overflow on an absurd failure count', () => {
    expect(Number.isFinite(backoffMs(Number.MAX_SAFE_INTEGER))).toBe(true)
  })

  it('blocks a sync while backing off', () => {
    const failing: ConnectionSyncState = {
      requestsToday: 0,
      lastAttemptAt: NOW,
      consecutiveFailures: 3,
    }

    const tooSoon = canSync(failing, 'scheduled', at(minutes(30)))
    expect(tooSoon.allowed).toBe(false)
    if (!tooSoon.allowed) {
      expect(tooSoon.reason).toMatch(/backing off/)
    }

    // ...and allows it once the wait has elapsed.
    expect(canSync(failing, 'scheduled', at(hours(1) + 1)).allowed).toBe(true)
  })

  /**
   * The specific thing the spec warns about: a retry loop burning the daily quota. Backoff plus a
   * shared budget means a persistently failing connection makes a handful of attempts a day, not
   * hundreds.
   */
  it('cannot burn the daily budget through retries', () => {
    let clock = NOW
    let attempts = 0
    const state: ConnectionSyncState = {
      requestsToday: 0,
      lastAttemptAt: null,
      consecutiveFailures: 0,
    }

    // Simulate a full day of a connection that fails every single time.
    const endOfDay = new Date(NOW.getTime() + hours(24))
    while (clock.getTime() < endOfDay.getTime() && attempts < 100) {
      const decision = canSync(state, 'scheduled', clock)
      if (decision.allowed) {
        attempts += 1
        state.requestsToday += 1
        state.consecutiveFailures += 1
        state.lastAttemptAt = clock
        clock = new Date(clock.getTime() + minutes(1))
      } else {
        clock = decision.retryAfter ?? endOfDay
      }
    }

    expect(attempts).toBeLessThanOrEqual(DAILY_REQUEST_BUDGET)
    // With exponential backoff it should be far fewer than the ceiling.
    expect(attempts).toBeLessThanOrEqual(8)
  })
})

describe('manual refresh rate limit', () => {
  it('refuses a second refresh immediately after the first', () => {
    const state: ConnectionSyncState = {
      requestsToday: 1,
      lastAttemptAt: NOW,
      consecutiveFailures: 0,
    }

    const decision = canSync(state, 'manual', at(minutes(1)))
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/moment ago/)
    }
  })

  it('allows it once the interval passes', () => {
    const state: ConnectionSyncState = {
      requestsToday: 1,
      lastAttemptAt: NOW,
      consecutiveFailures: 0,
    }
    expect(canSync(state, 'manual', at(MANUAL_REFRESH_MIN_INTERVAL_MS + 1)).allowed).toBe(true)
  })

  it('does not rate-limit scheduled syncs the same way', () => {
    const state: ConnectionSyncState = {
      requestsToday: 1,
      lastAttemptAt: NOW,
      consecutiveFailures: 0,
    }
    expect(canSync(state, 'scheduled', at(minutes(1))).allowed).toBe(true)
  })
})

describe('schedule jitter', () => {
  it('is stable for a given connection', () => {
    // A connection should land at roughly the same time each day, not wander.
    const first = jitterForSchedule('connection-abc', hours(1))
    const second = jitterForSchedule('connection-abc', hours(1))
    expect(first).toBe(second)
  })

  it('differs between connections', () => {
    const offsets = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) =>
        jitterForSchedule(`connection-${id}`, hours(1)),
      ),
    )
    // Not a strict guarantee, but a hash that collided for most of these would not be spreading.
    expect(offsets.size).toBeGreaterThan(5)
  })

  it('stays inside the window', () => {
    for (const id of ['a', 'bb', 'ccc', 'a-very-long-connection-identifier-uuid-like']) {
      const offset = jitterForSchedule(id, hours(1))
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(hours(1))
    }
  })

  it('handles a zero-width window without dividing by zero', () => {
    expect(jitterForSchedule('anything', 0)).toBe(0)
  })
})

describe('sync window', () => {
  it('pulls a year of history on first sync', () => {
    const start = syncWindowStart(null, NOW)
    expect(start.toISOString()).toBe('2025-08-03T14:30:00.000Z')
  })

  /**
   * The overlap is load-bearing. Transactions post late and get amended, so a window starting
   * exactly where the last one ended would miss both — silently, since nothing reports a
   * transaction that was never fetched.
   */
  it('overlaps two weeks on subsequent syncs', () => {
    const lastSuccess = new Date('2026-08-02T09:00:00.000Z')
    expect(syncWindowStart(lastSuccess, NOW).toISOString()).toBe('2026-07-19T09:00:00.000Z')
  })

  it('always starts before the last success', () => {
    const lastSuccess = new Date('2026-08-03T14:29:00.000Z')
    expect(syncWindowStart(lastSuccess, NOW).getTime()).toBeLessThan(lastSuccess.getTime())
  })
})
