/**
 * Copy for the settings screen.
 *
 * The groups are named for **what kind of thing** each row is, not for which screen it came from.
 * That is the whole organizing idea: a page that lists Household, Categories, Import, a checkbox and
 * a tab reorder in a flat column is five unrelated things in a row, and the reader has to work out
 * for themselves which of them are safe to poke at.
 */

export const SETTINGS_COPY = {
  title: 'Settings',

  /** Cheap and reversible. Nothing here touches data. */
  displayGroup: 'Display',
  /** The taxonomy, and the automation over it. */
  categorizingGroup: 'Categorizing',
  /** People, and getting data in. */
  householdGroup: 'Household',

  tabsTitle: 'Bottom tabs',
  tabsSummary: 'Which destinations sit in the bar, and in what order',
  tabsHelp: (slots: number): string =>
    `Pick up to ${slots} and put them in order. More always fills the last slot and holds everything else.`,

  /**
   * Counts rather than descriptions.
   *
   * A closed row reading only "Categories" makes you open it to learn anything at all. "38
   * categories" answers the question most people came with.
   */
  categoriesSummary: (count: number): string =>
    `${count} categor${count === 1 ? 'y' : 'ies'}`,
  rulesSummary: (count: number): string =>
    count === 0 ? 'None yet' : `${count} rule${count === 1 ? '' : 's'}`,

  importSummary: 'Bring in history from a CSV',
} as const
