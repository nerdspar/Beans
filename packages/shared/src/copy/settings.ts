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

  /**
   * One order, both layouts.
   *
   * Called "Navigation order" rather than "Bottom tabs" because it is no longer only the phone's
   * bar — the same list orders the desktop sidebar. The old name described where the setting showed
   * up rather than what it did, and it had gone from merely narrow to inaccurate.
   */
  tabsTitle: 'Navigation order',
  tabsHelp: (slots: number): string =>
    `Every destination, in the order you want them. On a wider screen this is the sidebar; on a phone the first ${slots} become the bottom bar and More holds the rest.`,

  /**
   * Marks the rows that reach the phone's bottom bar.
   *
   * The help text says "the first four" and this says which four, which are not the same job: the
   * list is ten rows and counting to four while scrolling is exactly the small friction a label
   * removes. It also survives the count changing.
   */
  tabsOnBar: 'Bottom tab',

  tabsReset: 'Reset to the default order',
  /** Announced rather than shown, so a save does not shift the layout mid-interaction. */
  tabsSaving: 'Saving your tab order',
  /**
   * A save the server refused.
   *
   * Shown, not merely announced — unlike the saving state, this one changes what the reader should
   * do next, and the order in front of them is not the order that was kept. Plain and factual: the
   * failure is about their navigation, but it arrives while they are configuring an app, and a
   * joke about it would be a joke about something being broken.
   */
  tabsSaveFailed: 'That change could not be saved, so the order above has been put back.',
} as const
