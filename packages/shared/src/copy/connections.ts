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

/**
 * Copy for managing accounts.
 *
 * The screen replaced a separate connections page that listed one connection and nothing else. An
 * account is what a person thinks about; a connection is only how some of them arrive, which is why
 * it appears here as a grouping with its own health rather than as a destination of its own.
 */
export const ACCOUNTS_COPY = {
  title: 'Accounts',
  empty: 'No accounts yet',
  emptyDetail:
    'Connect an institution to pull balances automatically, or add something Beans cannot reach — a house, a car, a private investment.',

  manualGroup: 'Manual',
  manualGroupDetail: 'Kept up to date by you. Beans never changes these.',
  closed: 'Closed',
  showClosed: 'Show closed accounts',

  edit: 'Edit',
  editTitle: 'Edit account',
  name: 'Name',
  institution: 'Institution',
  type: 'Type',
  taxTreatment: 'Tax treatment',
  signInverted: 'Record the opposite of what the provider sends',
  /** Stated because the consequence is invisible on the chart, which plots liabilities as magnitudes. */
  signInvertedHelp:
    'Changing this negates the balance and rebuilds this account’s history to match.',
  /*
   * Reworded once closing gained a date. It used to promise the history was kept while the account
   * was left out of net worth, which was not what happened — the account was dropped from the
   * rollup entirely, so its history disappeared from the chart too and every past total fell.
   */
  markClosed: 'Closed — keep the history, stop counting it from the closing date',
  /*
   * Tax treatment decides which bucket an investment lands in on the portfolio screen — how much
   * is already taxed, how much is deferred, how much comes out tax-free. Nothing could set it until
   * now, which left every account on the type's default and the split showing a single bucket.
   */
  taxTreatmentHelp:
    'Splits the portfolio into taxable, deferred and tax-free. Providers do not report this, so it has to be set here.',

  closedOnLabel: 'Closed on',
  closedOnHelp:
    'History keeps everything up to this date, and the account counts as nothing afterwards.',
  save: 'Save changes',
  saving: 'Saving',
  saveFailed: 'Could not save those changes.',
  cancel: 'Cancel',

  connectionHeading: 'Bank connection',
  connected: 'Connected through SimpleFIN',
  notConnected: 'No bank connection',
  notConnectedDetail:
    'One SimpleFIN connection covers every institution linked inside your Bridge account, so this is usually a one-time setup.',
  /** A second connection is for a second person, not a second bank. */
  addAnotherConnection: 'Add another connection',
  addAnotherHelp: 'For a household member with their own SimpleFIN account.',
  accountsBehind: (count: number): string => `${count} account${count === 1 ? '' : 's'}`,

  addManual: 'Add manual account',
  addManualTitle: 'Add a manual account',
  addManualBlurb:
    'For anything SimpleFIN cannot reach. You enter the value, and update it whenever it changes.',
  balance: 'Current value',
  balanceHelp: 'Enter what it is worth. Beans applies the sign for the type you chose.',
  asOf: 'As of',
  asOfHelp: 'The date this value was true. History starts here.',
  create: 'Add account',
  creating: 'Adding',
  createFailed: 'Could not add that account.',

  /*
   * Deletion copy. It states what is lost in numbers rather than warning in the abstract, and offers
   * closing first — closing is the right answer for an account that was real, and deletion only for
   * one added by mistake. The destructive button is never the one under your thumb.
   */
  delete: 'Delete account',
  deleteTitle: 'Delete this account?',
  deleteBlurb:
    'This removes the account and everything recorded against it. It cannot be undone, and a future sync will not bring it back.',
  deleteCounts: (transactions: number): string =>
    transactions === 0
      ? 'It has no transactions.'
      : `${transactions} transaction${transactions === 1 ? '' : 's'} and this account’s balance history will be deleted with it.`,
  deleteSuggestion:
    'If the account was real, close it instead — the history stays and it stops counting toward net worth.',
  closeInstead: 'Close it instead',
  deleteConfirm: 'Delete permanently',
  deleting: 'Deleting',
  deleteFailed: 'Could not delete that account.',

  updateBalance: 'Update value',
  updateBalanceTitle: 'Update value',
  updateBalanceBlurb:
    'The new figure is held from this date until the next update — a step, not a slope, because nothing is known about the days in between.',
  record: 'Record value',
} as const
