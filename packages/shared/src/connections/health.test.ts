import { describe, expect, it } from 'vitest'
import { connectionBanner, describeAge } from '../copy/connection.js'
import { assessConnection, type ConnectionHealth } from './health.js'

const TODAY = '2026-08-03'

function health(overrides: Partial<ConnectionHealth> = {}): ConnectionHealth {
  return {
    status: 'healthy',
    lastSuccessAt: '2026-08-03T12:00:00.000Z',
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe('assessConnection', () => {
  it('asks for nothing when the connection is healthy', () => {
    expect(assessConnection(health(), TODAY)).toEqual({
      severity: 'ok',
      action: 'none',
      daysSinceSuccess: 0,
    })
  })

  /**
   * The distinction the whole module exists for: a connection Beans will fix by itself must not
   * send the user off to re-authorize their bank. Do that on every transient failure and the
   * warning becomes noise the user learns to dismiss.
   */
  it('waits out a first failure instead of demanding a reconnect', () => {
    const assessment = assessConnection(
      health({ status: 'error', consecutiveFailures: 1, lastSuccessAt: '2026-08-02T12:00:00.000Z' }),
      TODAY,
    )
    expect(assessment.action).toBe('wait')
    // Caution, not attention: red is reserved for what the user actually has to fix.
    expect(assessment.severity).toBe('caution')
  })

  it('still waits at two failures, which can be one outage', () => {
    expect(
      assessConnection(health({ status: 'error', consecutiveFailures: 2 }), TODAY).action,
    ).toBe('wait')
  })

  it('asks for a reconnect once failures are persistent', () => {
    expect(
      assessConnection(health({ status: 'error', consecutiveFailures: 3 }), TODAY).action,
    ).toBe('reconnect')
  })

  it('asks for a reconnect when a sync has never succeeded', () => {
    // No last success means nothing to wait for — whatever was entered at setup did not work.
    const assessment = assessConnection(
      health({ status: 'error', lastSuccessAt: null, consecutiveFailures: 1 }),
      TODAY,
    )
    expect(assessment).toEqual({ severity: 'attention', action: 'reconnect', daysSinceSuccess: null })
  })

  describe('stale, where nothing is erroring', () => {
    it('asks for a sync rather than a reconnect', () => {
      const assessment = assessConnection(
        health({ status: 'stale', lastSuccessAt: '2026-07-29T12:00:00.000Z' }),
        TODAY,
      )
      expect(assessment).toEqual({ severity: 'caution', action: 'sync-now', daysSinceSuccess: 5 })
    })

    it('is caution rather than attention — nothing is broken yet', () => {
      expect(
        assessConnection(health({ status: 'stale', lastSuccessAt: '2026-08-01T12:00:00.000Z' }), TODAY)
          .severity,
      ).toBe('caution')
    })

    /**
     * SimpleFIN can keep returning a stale balance without ever erroring when an institution has
     * quietly stopped authorizing the link. "No error" is not evidence the connection works, so age
     * alone has to be able to escalate.
     */
    it('escalates to a reconnect after a month of silence', () => {
      const assessment = assessConnection(
        health({ status: 'stale', lastSuccessAt: '2026-07-04T12:00:00.000Z' }),
        TODAY,
      )
      expect(assessment.daysSinceSuccess).toBe(30)
      expect(assessment.action).toBe('reconnect')
      expect(assessment.severity).toBe('attention')
    })

    it('does not escalate a day early', () => {
      expect(
        assessConnection(health({ status: 'stale', lastSuccessAt: '2026-07-05T12:00:00.000Z' }), TODAY)
          .action,
      ).toBe('sync-now')
    })
  })

  it('never returns ok for a status that is not healthy', () => {
    for (const status of ['stale', 'error'] as const) {
      for (const failures of [0, 1, 5]) {
        const assessment = assessConnection(health({ status, consecutiveFailures: failures }), TODAY)
        expect(assessment.severity, `${status}/${failures}`).not.toBe('ok')
        expect(assessment.action, `${status}/${failures}`).not.toBe('none')
      }
    }
  })
})

describe('describeAge', () => {
  it.each([
    [0, 'today'],
    [1, 'yesterday'],
    [3, '3 days ago'],
    [6, '6 days ago'],
  ])('renders %d days as %s', (days, expected) => {
    expect(describeAge(days, '7/30/2026')).toBe(expected)
  })

  it('falls back to the date once days stop being legible', () => {
    expect(describeAge(7, '7/27/2026')).toBe('on 7/27/2026')
  })

  it('treats a negative age as today rather than emitting a negative count', () => {
    // Clock skew between the server and a client should never produce "-1 days ago".
    expect(describeAge(-2, '8/5/2026')).toBe('today')
  })

  it('says never when there is no successful sync to date', () => {
    expect(describeAge(null, null)).toBe('never')
  })
})

describe('connectionBanner', () => {
  const base = { institution: 'Bank of America', age: '3 days ago', neverSucceeded: false }

  it('renders nothing at all when there is no action', () => {
    expect(connectionBanner({ ...base, action: 'none' })).toBeNull()
  })

  it('always states how old the data is', () => {
    // Staleness without a date is an anxiety generator rather than information.
    for (const action of ['wait', 'sync-now', 'reconnect'] as const) {
      const copy = connectionBanner({ ...base, action })
      expect(copy?.detail, action).toContain('3 days ago')
    }
  })

  it('always offers something to press', () => {
    for (const action of ['wait', 'sync-now', 'reconnect'] as const) {
      expect(connectionBanner({ ...base, action })?.actionLabel, action).toBeTruthy()
    }
  })

  it('distinguishes a connection that never worked from one that broke', () => {
    const broke = connectionBanner({ ...base, action: 'reconnect' })
    const never = connectionBanner({ ...base, action: 'reconnect', neverSucceeded: true })
    expect(never?.title).not.toBe(broke?.title)
    expect(never?.title).toMatch(/never/)
    // The one that broke cites the last good sync; the one that never worked has none to cite.
    expect(broke?.detail).toContain('3 days ago')
    expect(never?.detail).not.toContain('3 days ago')
  })

  it('does not blame the user or the bank when nothing is failing', () => {
    const copy = connectionBanner({ ...base, action: 'sync-now' })
    expect(copy?.detail).toMatch(/Nothing is failing/)
  })

  /**
   * The copy rules allow personality in error states and this banner declines it: the user is being
   * told their numbers are wrong and asked to act. Guards against a future edit adding a joke here.
   */
  it('stays plain — no exclamation marks anywhere in the banner copy', () => {
    for (const action of ['wait', 'sync-now', 'reconnect'] as const) {
      for (const never of [true, false]) {
        const copy = connectionBanner({ ...base, action, neverSucceeded: never })
        expect(`${copy?.title} ${copy?.detail}`, action).not.toMatch(/!/)
      }
    }
  })
})
