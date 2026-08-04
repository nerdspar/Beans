import type { Mailer } from './mailer.js'

/**
 * Sending an invite, and reporting which of the several possible things happened.
 *
 * Split out from the route so it can be tested without a database or a server. It previously lived
 * inline and returned a boolean, and the untested branch is precisely the one that misreported:
 * a delivery failure and an unconfigured mailer both produced `false`, and the client — having
 * nothing else to go on — told the user their server had no mail configured. It sent somebody
 * hunting for an API key they had already set.
 */

/**
 * What happened to the invite email.
 *
 * `not-configured` and `failed` are deliberately distinct: one is a deployment that never intended
 * to send mail, the other is a deployment that tried and could not. They call for different actions
 * from the person reading the screen, so they must not share a message.
 */
export type InviteDelivery = 'sent' | 'not-configured' | 'failed' | 'no-address'

export type InviteEmail = {
  to: string | undefined
  link: string
  expiresAt: Date
}

/**
 * Best effort, always.
 *
 * The invite exists and its link has already been returned by the time this runs. A mail failure
 * must never propagate — losing a just-created invite because a provider was down would be a far
 * worse outcome than not emailing it.
 */
export async function deliverInvite(
  mailer: Mailer,
  invite: InviteEmail,
  onError: (error: unknown) => void,
): Promise<InviteDelivery> {
  if (invite.to === undefined) return 'no-address'
  if (!mailer.enabled) return 'not-configured'

  try {
    await mailer.send({
      to: invite.to,
      subject: 'You have been invited to a Beans household',
      text:
        `You have been invited to share a household on Beans.\n\n` +
        `Open this link to join:\n${invite.link}\n\n` +
        `The link expires on ${invite.expiresAt.toDateString()}.`,
    })
    return 'sent'
  } catch (error) {
    /*
     * The reason goes to the caller's log, not to the response. A provider error message can quote
     * the recipient address, and the response is rendered on a screen that may be shared.
     */
    onError(error)
    return 'failed'
  }
}
