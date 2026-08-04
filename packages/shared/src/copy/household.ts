/**
 * Copy for the household screen.
 *
 * The invite copy is the careful part. Sharing a household means sharing every balance in it, and
 * that is said plainly rather than left to be discovered — an invite is the single most consequential
 * button in the app, and the only one whose effect reaches another person.
 */

export const HOUSEHOLD_COPY = {
  title: 'Household',
  loading: 'Counting the beans.',

  membersHeading: 'Members',
  you: 'You',
  owner: 'Owner',
  member: 'Member',

  /*
   * Joining. The tone is deliberately flat — someone arriving here is being handed access to
   * another person's entire financial picture, and that is not a moment for warmth.
   */
  /**
   * The name a household gets before anyone names it.
   *
   * Plain on purpose: it appears in the header of the household page and next to an invite, and a
   * placeholder that tries to be charming is worse than one that is obviously a placeholder.
   */
  defaultName: 'My household',

  joinHeading: 'Join this household',
  joinBlurb: 'You have been invited to share a household on Beans.',
  joinSignIn: 'Sign in or create an account to accept this invite.',
  joining: 'Joining',
  joinFailed: 'Could not join this household.',
  joinContinue: 'Continue to Beans',

  /** Renaming, now that the name is asked for here rather than at sign-up. */
  nameHeading: 'Household name',
  nameHelp: 'Anyone you invite will see this.',
  nameSave: 'Save',
  nameSaving: 'Saving',
  nameSaved: 'Saved.',
  nameFailed: 'Could not rename the household.',

  inviteHeading: 'Invite someone',
  inviteBlurb:
    'Anyone who joins sees every shared account in this household, including balances and transactions. Only invite someone you would show your bank statements to.',
  inviteEmail: 'Their email',
  inviteSend: 'Create invite',
  inviteSending: 'Creating',
  inviteFailed: 'Could not create the invite.',
  /** Shown whether or not mail went out, because the link is what actually works. */
  inviteLink: 'Send them this link. It expires, and works once.',
  /**
   * One line per outcome, because they call for different actions.
   *
   * These were a single boolean, and a delivery failure was reported as "email is not configured" —
   * which sent somebody looking for an API key they had already set. A server that cannot say which
   * happened should not pick one.
   */
  inviteDelivery: {
    sent: 'Also emailed to them.',
    'not-configured': 'Email is not set up on this server, so send the link yourself.',
    failed:
      'Sending the email failed, so send the link yourself. The server log has the reason — look for “invite email delivery failed”.',
    'no-address': 'No email address given, so send the link yourself.',
  },
  copy: 'Copy link',
  copied: 'Copied',

  pendingHeading: 'Pending invites',
  pendingNone: 'No pending invites.',
  revoke: 'Revoke',
  expires: 'Expires',

  /** Only owners can invite; saying so beats hiding the control and leaving it unexplained. */
  ownerOnly: 'Only the household owner can invite people.',
} as const
