import { describe, expect, it, vi } from 'vitest'
import { deliverInvite } from './deliver-invite.js'
import type { Mailer } from './mailer.js'

/**
 * The four outcomes.
 *
 * Written after a real report: an install with a Resend key configured was told "email is not
 * configured on this server". Two different situations shared one boolean, and the screen picked
 * the wrong one to describe. The distinction between `not-configured` and `failed` is the whole
 * point of this file.
 */

/*
 * Fixed, never `new Date()` — the expiry appears in the body and would otherwise differ per run.
 *
 * Midday rather than midnight UTC on purpose. `toDateString()` renders in the *server's* local
 * zone, so a midnight-UTC fixture reads as the previous day anywhere west of UTC: the test would
 * pass in CI and fail on a laptop, which is the worst kind of failure to debug. Midday is the same
 * calendar day from UTC-11 to UTC+12.
 */
const EXPIRES_AT = new Date('2026-08-31T12:00:00.000Z')

function mailerThat(behaviour: 'sends' | 'throws' | 'disabled'): Mailer {
  return {
    enabled: behaviour !== 'disabled',
    send: behaviour === 'throws' ? vi.fn().mockRejectedValue(new Error('Resend rejected the message: domain not verified')) : vi.fn().mockResolvedValue(undefined),
  }
}

const invite = { to: 'wife@example.com', link: 'https://beans.example/join/abc', expiresAt: EXPIRES_AT }

describe('deliverInvite', () => {
  it('reports sent when the mailer accepts it', async () => {
    expect(await deliverInvite(mailerThat('sends'), invite, () => {})).toBe('sent')
  })

  it('reports not-configured when there is no mail transport', async () => {
    expect(await deliverInvite(mailerThat('disabled'), invite, () => {})).toBe('not-configured')
  })

  /** The reported bug: this used to be indistinguishable from `not-configured`. */
  it('reports failed — not not-configured — when a configured mailer throws', async () => {
    const outcome = await deliverInvite(mailerThat('throws'), invite, () => {})
    expect(outcome).toBe('failed')
    expect(outcome).not.toBe('not-configured')
  })

  it('reports no-address when no email was given', async () => {
    const mailer = mailerThat('sends')
    expect(await deliverInvite(mailer, { ...invite, to: undefined }, () => {})).toBe('no-address')
    expect(mailer.send).not.toHaveBeenCalled()
  })

  it('passes the failure to the log callback rather than the caller', async () => {
    const onError = vi.fn()
    await expect(deliverInvite(mailerThat('throws'), invite, onError)).resolves.toBe('failed')
    expect(onError).toHaveBeenCalledOnce()
  })

  it('never throws, so a mail outage cannot lose a created invite', async () => {
    const exploding: Mailer = { enabled: true, send: () => { throw new Error('socket hang up') } }
    await expect(deliverInvite(exploding, invite, () => {})).resolves.toBe('failed')
  })

  it('puts the link and expiry in the body and nothing else', async () => {
    const mailer = mailerThat('sends')
    await deliverInvite(mailer, invite, () => {})
    const sent = vi.mocked(mailer.send).mock.calls[0]?.[0]
    expect(sent?.to).toBe('wife@example.com')
    expect(sent?.text).toContain('https://beans.example/join/abc')
    expect(sent?.text).toContain('Aug 31 2026')
  })
})
