import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

/**
 * Which header the sign-in rate limiter counts against.
 *
 * Worth testing despite being one line of parsing, because getting it wrong is silent in both
 * directions. Name a header nothing sets and every request resolves to no address, so all of them
 * share a single bucket and five sign-in attempts a minute are spent by whoever gets there first.
 * Name one the client can set and the limit is per-attacker-chosen-value, which is no limit.
 */

/** Enough to satisfy the schema. Fixed, never generated — the values here are not the subject. */
const BASE = {
  DATABASE_URL: 'postgres://beans_app:pw@db:5432/beans',
  MASTER_KEY_FILE: '/run/secrets/master.key',
  PUBLIC_URL: 'https://beans.nerdspar.com',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
} as const

describe('trustedIpHeader', () => {
  it('defaults to x-forwarded-for, which every reverse proxy sets', () => {
    expect(loadConfig({ ...BASE }).trustedIpHeader).toBe('x-forwarded-for')
  })

  it('takes the header the deployment names', () => {
    expect(loadConfig({ ...BASE, TRUSTED_IP_HEADER: 'cf-connecting-ip' }).trustedIpHeader).toBe(
      'cf-connecting-ip',
    )
  })

  it('lowercases it, so the spelling in Cloudflare’s docs works', () => {
    // Copied from Cloudflare it reads `CF-Connecting-IP`. Better Auth looks it up through
    // `Headers.get()`, which is case-insensitive, so that spelling would in fact work — normalised
    // here anyway so the value cannot depend on which lookup path a future version takes, and so
    // two deployments spelling it differently are visibly the same configuration.
    expect(loadConfig({ ...BASE, TRUSTED_IP_HEADER: 'CF-Connecting-IP' }).trustedIpHeader).toBe(
      'cf-connecting-ip',
    )
  })

  it('treats empty and whitespace as unset rather than as a header named ""', () => {
    // Compose writes `TRUSTED_IP_HEADER: ''` for anything left blank, and an empty header name
    // resolves nothing — the shared-bucket failure above, arrived at by leaving a field alone.
    expect(loadConfig({ ...BASE, TRUSTED_IP_HEADER: '' }).trustedIpHeader).toBe('x-forwarded-for')
    expect(loadConfig({ ...BASE, TRUSTED_IP_HEADER: '   ' }).trustedIpHeader).toBe('x-forwarded-for')
  })
})
