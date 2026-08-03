import { describe, expect, it } from 'vitest'
import { AUTH_COPY } from './auth.js'

/**
 * The rate-limit message.
 *
 * Worth testing because it replaced a bug rather than a blank: a throttled sign-in was reported as
 * "that email and password did not match", which is a claim the server never made and sends someone
 * to reset a password that was fine.
 */
describe('rateLimited', () => {
  it('counts in seconds below a minute', () => {
    expect(AUTH_COPY.rateLimited(50)).toBe('Too many attempts just now. Try again in 50 seconds.')
  })

  it('rounds up to whole minutes above one', () => {
    // 216 seconds is 3.6 minutes; "3 minutes" would have the user come back to another refusal.
    expect(AUTH_COPY.rateLimited(216)).toBe('Too many attempts just now. Try again in 4 minutes.')
  })

  it('says minute, singular, at exactly one', () => {
    expect(AUTH_COPY.rateLimited(60)).toBe('Too many attempts just now. Try again in 1 minute.')
  })

  it('degrades to a vague wait rather than a wrong number', () => {
    // A missing or unparsable `x-retry-after` arrives here as 0. "0 seconds" would be worse than
    // saying nothing precise.
    for (const seconds of [0, -1]) {
      expect(AUTH_COPY.rateLimited(seconds)).toBe('Too many attempts just now. Try again in a moment.')
    }
  })

  it('never blames the credentials', () => {
    for (const seconds of [0, 30, 60, 300]) {
      const message = AUTH_COPY.rateLimited(seconds)
      expect(message).not.toMatch(/password|email|match|exist/i)
    }
  })
})

describe('failure copy', () => {
  /**
   * The rule the sign-up message broke: it used to add "the email may already be in use", which was
   * a guess, and was wrong in the case people actually hit — a rate-limited request.
   */
  it('does not speculate about why sign-up failed', () => {
    expect(AUTH_COPY.signUpFailed).not.toMatch(/already|in use|exist/i)
  })

  it('keeps sign-in failure non-committal about which half was wrong', () => {
    // Distinguishing an unknown email from a bad password tells an attacker which emails have
    // accounts, so the copy must not either.
    expect(AUTH_COPY.signInFailed).toMatch(/email and password/i)
    expect(AUTH_COPY.signInFailed).not.toMatch(/no account|not found|incorrect password/i)
  })
})
