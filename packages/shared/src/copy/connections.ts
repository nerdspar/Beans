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

  /**
   * The account's type and the sign it would be recorded with disagree.
   *
   * Names both halves rather than saying "mismatch", because the reader has two toggles in front of
   * them and needs to know which one is wrong. Calm and factual: this is a warning about money being
   * recorded backwards, which is not a place for a voice.
   */
  signMismatchLiability: (type: string): string =>
    `A ${type} is money you owe, but this would be recorded as money you have.`,
  signMismatchAsset: (type: string): string =>
    `A ${type} is money you have, but this would be recorded as money you owe.`,

  lowConfidence: 'Beans is guessing at this type. Check it.',

  confirmAction: 'Confirm and sync',
  confirming: 'Syncing',
  confirmFailed: 'Could not confirm these accounts. Nothing was changed.',

  /**
   * Named for both jobs, because it does two and only one was discoverable.
   *
   * It re-asks the type and sign questions — the original purpose — and it is also **the way newly
   * linked accounts get in**. Nothing said so, which left the second job reachable only by already
   * knowing about it.
   */
  review: 'Find new accounts',
  reviewTitle: 'Check these balances',
  /**
   * Both jobs, in the order they matter.
   *
   * Anything linked at SimpleFIN since setup arrives here — that is the only route in, and it went
   * unmentioned. Re-confirming an account already added updates it and re-runs the sync, which
   * rebuilds every balance snapshot from the corrected figure, so history heals rather than keeping
   * the old shape.
   */
  reviewBlurb:
    'Anything linked at SimpleFIN since setup appears here, marked as new. Answers for accounts already added replace the ones given before, and their balance history is rebuilt to match.',

  /** Marks the rows that were not here last time, so a long list does not hide the point. */
  newAccount: 'New',

  /**
   * The one thing that genuinely cannot be done in Beans.
   *
   * SimpleFIN is a read-only protocol: `/info`, `/create`, `/claim`, `/accounts`, and nothing that
   * links or unlinks an institution. `/create` is the protocol's own answer to this — a page the
   * application sends the user to — so it is linked rather than described.
   */
  manageAtBridge: 'Add or remove a bank',
  manageAtBridgeHelp:
    'Linking a bank needs its own login, so it happens at SimpleFIN. Everything after that — names, types, closing, removing — is here. Come back and use “Find new accounts” to pull in anything you add.',

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

  /**
   * Said when the shared demo account tries to connect an institution.
   *
   * Framed around the visitor's own risk rather than a permission they lack, because that is the
   * actual reason: anyone else who signs into the demo would see whatever they connected.
   */
  demoConnectBlocked:
    'This is a shared demo account, so it cannot connect a real institution — anyone else trying the demo would see it. Everything already here is yours to explore.',

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
  /**
   * The way into importing, now that it is reached from here rather than from the navigation.
   *
   * It sits on this screen because it is the same job: getting account data into Beans. Settings
   * was the other candidate and the wrong one — it was deliberately emptied down to preferences,
   * and an import is not a preference.
   *
   * Named for the outcome rather than the mechanism. "Import data" is what the file does; "history
   * a connection cannot reach" is why somebody would want to.
   */
  importHeading: 'Import from a file',
  importDetail:
    'History from before you connected, or an institution SimpleFIN does not reach. Transactions or balances, from a CSV.',
  importAction: 'Import a file',

  /**
   * The last four digits, appended to an account name.
   *
   * Here rather than written out at each screen, because it was written out at two and they have to
   * match: the same account named two ways on the list and on its own detail screen reads as two
   * accounts. Takes the mask rather than the account so nothing has to reach into a domain type.
   */
  maskSuffix: (mask: string): string => ` - Ending in ${mask}`,

  name: 'Name',
  /**
   * An example, not a default. A street address is the case worth showing: it is what a manual
   * property asset should be called, and "Manual" or "House" is what people type instead.
   */
  namePlaceholder: '18 Atlantic Xing',
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
  /**
   * The clock time matters, not just the day.
   *
   * Whether a fetch happened at 4pm or at 10pm decides whether it could contain that day's market
   * close — so this is the line that explains a balance trailing a brokerage app, and "today" on
   * its own could not.
   */
  lastSynced: (age: string): string => `last synced ${age}`,

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
