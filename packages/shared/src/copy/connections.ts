import type { AccountType } from '../accounts/classification.js'

/**
 * Copy for connecting an institution.
 *
 * The confirmation step is the one screen in Beans where a mistake is both silent and expensive, so
 * its copy does one job: make the number the user is agreeing to impossible to misread. It states
 * what the provider sent and what Beans will record, in plain words, and asks about the difference.
 *
 * No personality anywhere near the balances. The voice appears only in the empty state.
 */

export const CONNECTION_COPY = {
  title: 'Connections',
  empty: 'No institutions connected',
  emptyDetail:
    'Beans gets balances through SimpleFIN, so nothing reaches it until you connect an institution. Bring a setup token and this takes a minute.',

  connect: 'Connect an institution',
  connectTitle: 'Connect an institution',
  setupTokenLabel: 'SimpleFIN setup token',
  setupTokenHelp:
    'Paste the token from your SimpleFIN Bridge. It is claimed once and exchanged for a credential Beans keeps encrypted — the token itself is not stored.',
  claim: 'Continue',
  claiming: 'Claiming the token',

  /*
   * A claim failure is nearly always a token that was already used. SimpleFIN tokens are
   * single-use, and "claim it again" is the fix a user can actually carry out.
   */
  claimFailed:
    'That token could not be claimed. SimpleFIN tokens work only once — generate a fresh one and try again.',

  confirmTitle: 'Check these balances',
  confirmBlurb:
    'SimpleFIN does not tell Beans whether a balance is money you have or money you owe, and institutions disagree. Check each one before it counts toward your net worth.',

  provider: 'SimpleFIN sends',
  stored: 'Beans will record',
  asAsset: 'Money you have',
  asDebt: 'Money you owe',
  flip: 'Flip the sign',
  accountType: 'Type',
  include: 'Include this account',
  skipped: 'Not included',
  alreadyLinked: 'Already connected — this will update it, not duplicate it',

  lowConfidence: 'Beans is guessing at this type. Check it.',

  confirmAction: 'Confirm and sync',
  confirming: 'Syncing',
  confirmFailed: 'Could not confirm these accounts. Nothing was changed.',

  review: 'Review accounts',
  reviewTitle: 'Check these balances',
  /**
   * The way back from a sign that was answered wrong.
   *
   * Re-confirming updates the account and then re-runs the sync, which rebuilds every balance
   * snapshot from the corrected figure — so the history heals rather than keeping the old shape.
   */
  reviewBlurb:
    'Answers here replace the ones given when this connection was set up, and the balance history is rebuilt to match.',

  syncNow: 'Sync now',
  syncing: 'Syncing',
  reconnect: 'Reconnect',
  reconnectTitle: 'Reconnect',
  reconnectBlurb:
    'Generate a fresh setup token and paste it here. Your existing accounts and their history stay exactly as they are — only the credential is replaced.',
  reconnectAction: 'Replace credential',

  accountsConnected: (created: number, updated: number): string => {
    const parts: string[] = []
    if (created > 0) parts.push(`${created} account${created === 1 ? '' : 's'} added`)
    if (updated > 0) parts.push(`${updated} updated`)
    return parts.length === 0 ? 'Nothing changed' : parts.join(', ')
  },

  /** Provider errors are surfaced, never swallowed — they are the only warning of a silent stall. */
  providerErrors: 'SimpleFIN reported:',
} as const

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  depository: 'Cash',
  credit: 'Credit card',
  loan: 'Loan',
  mortgage: 'Mortgage',
  investment: 'Investment',
  other_asset: 'Other asset',
  other_liability: 'Other liability',
}
