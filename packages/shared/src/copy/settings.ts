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

  tabsTitle: 'Bottom tabs',
  tabsHelp: (slots: number): string =>
    `Pick up to ${slots} and put them in order. More always fills the last slot and holds everything else.`,
} as const
