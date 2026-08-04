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

  inviteHeading: 'Invite someone',
  inviteBlurb:
    'Anyone who joins sees every shared account in this household, including balances and transactions. Only invite someone you would show your bank statements to.',
  inviteEmail: 'Their email',
  inviteSend: 'Create invite',
  inviteSending: 'Creating',
  inviteFailed: 'Could not create the invite.',
  /** Shown whether or not mail went out, because the link is what actually works. */
  inviteLink: 'Send them this link. It expires, and works once.',
  inviteEmailed: 'Also emailed to them.',
  inviteNotEmailed: 'Email is not configured on this server, so copy the link yourself.',
  copy: 'Copy link',
  copied: 'Copied',

  pendingHeading: 'Pending invites',
  pendingNone: 'No pending invites.',
  revoke: 'Revoke',
  expires: 'Expires',

  /** Only owners can invite; saying so beats hiding the control and leaving it unexplained. */
  ownerOnly: 'Only the household owner can invite people.',
} as const
