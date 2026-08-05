/**
 * Copy for the settings screen.
 *
 * Short, because the page is. Everything that used to live here — the household, categories, rules,
 * import — is a destination of its own now: a settings *list* navigates, it does not unfold, and
 * folding four screens into expanding sections was why the two real preferences looked homeless.
 */

export const SETTINGS_COPY = {
  title: 'Settings',
  /**
   * Says where the rest went.
   *
   * Somebody who has been opening settings to reach categories needs one sentence, once, or they
   * will conclude the feature was removed.
   */
  blurb: 'Categories, rules, import and your household have their own screens — find them under More.',

  /**
   * The trust switch, stated as a trade rather than as a feature.
   *
   * Both readings have to be available before somebody chooses, because the failure mode is silent:
   * a chart drawn from an incomplete export is not obviously wrong, it is just gradually further
   * from the truth the further left you look.
   */
  historyTrustTitle: 'Imported history',
  historyTrustLabel: 'Use imported transactions to extend net worth further back',
  historyTrustOn:
    'Net worth is drawn back to your earliest transaction. Balances before your accounts connected are worked out from the imported transactions, so anything missing from that export shows as drift — larger the further back you look.',
  historyTrustOff:
    'Net worth starts where each account connected. Imported transactions still appear in Transactions and Cash Flow; they just do not move the chart further back.',
  /** Said because the request is slow and the reason is not obvious. */
  historyTrustRebuilding: 'Rebuilding every account’s history',
  historyTrustDone: (accounts: number): string =>
    `Rebuilt ${accounts} account${accounts === 1 ? '' : 's'}.`,
  /** Reversibility is the thing that makes it safe to try. */
  historyTrustReversible: 'You can change this back at any time — nothing is overwritten.',

  tabsTitle: 'Bottom tabs',
  tabsHelp: (slots: number): string =>
    `Pick up to ${slots} and put them in order. More always fills the last slot and holds everything else.`,
} as const
