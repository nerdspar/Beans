/**
 * Copy for CSV import.
 *
 * The mapping step carries the weight. A wrong amount column does not look wrong — it produces a
 * total, and the total is plausible — so the copy pushes the user to check sample values rather than
 * trust a header name, and names the sign convention explicitly instead of inferring it.
 */

export const IMPORT_COPY = {
  title: 'Import',
  blurb:
    'Bring history from another app. Nothing is added until you have seen the rows, and an import can be reversed afterwards.',

  chooseFile: 'Choose a CSV file',
  reading: 'Reading',
  readFailed: 'Could not read that file as a CSV.',

  account: 'Import into',
  accountHelp: 'Every row goes to this account.',

  /*
   * The multi-account case. A whole-portfolio export names its accounts on every row, and mapping
   * them is the difference between history landing where it belongs and all of it landing in one
   * account — which imports cleanly and is entirely wrong.
   */
  accountsHeading: 'Match the accounts',
  accountsHelp:
    'This file covers more than one account. Match each one to yours. Anything left unmatched is skipped, not guessed — it will be listed in the preview.',
  accountUnmatched: 'Skip',
  /*
   * Creating an account that no longer exists.
   *
   * A closed card or a bank the provider no longer lists cannot be matched to anything, and without
   * this its history has nowhere to go — which is most of the reason to import an old export at all.
   */
  accountCreate: 'Create as closed account',
  accountCreateType: 'What was it',
  accountCreateClosedOn: 'Closed on',
  accountCreateHelp:
    'Its history ends on this date and it counts as nothing afterwards, so past net worth stays right without a dead account in today’s.',
  accountsMatched: (matched: number, total: number): string =>
    matched === total
      ? `All ${total} matched.`
      : `${matched} of ${total} matched. The rest will be skipped.`,
  source: 'Where it came from',
  /** Named because getting it wrong inverts every amount, and nothing downstream would notice. */
  sourceHelp:
    'This decides how amounts are signed. Getting it wrong flips spending and income, so check the preview.',

  mapping: 'Columns',
  mappingHelp:
    'Beans guesses from the headers. Check the sample values — “Amount” and “Debit” look alike until you notice one is never negative.',
  ignore: 'Ignore',

  stage: 'Continue',
  staging: 'Reading rows',
  stageFailed: 'Could not read those rows.',

  previewHeading: 'Check these rows',
  previewBlurb: 'Nothing has been added yet. This is what would be.',
  /**
   * The headline count only. The reasons are listed beneath it.
   *
   * It used to say the rest "could not be parsed", which is true of only one of the two ways a row
   * gets set aside — a row naming an unmapped account parses perfectly and was skipped for having
   * nowhere to go. Telling somebody their file is malformed when the fix is to add an account sends
   * them to rewrite a mapping that was never wrong.
   */
  rowsParsed: (parsed: number, total: number): string =>
    parsed === total
      ? `${total.toLocaleString()} row${total === 1 ? '' : 's'} read.`
      : `${parsed.toLocaleString()} of ${total.toLocaleString()} rows will be imported.`,

  /**
   * Skips, counted separately and stated in the ordinary voice.
   *
   * A partial re-import — pick up one account, skip the other forty — is a normal thing to do, and
   * it used to produce a page of red. Choices the reader just made are not findings.
   */
  // ── Past imports ───────────────────────────────────────────────────────────
  /**
   * The undo path, given a home.
   *
   * Committing landed on a page offering to reverse, and that page was the only route to it — so
   * navigating away to check the numbers, which is the very next thing anybody does, lost it.
   */
  historyHeading: 'Past imports',
  historyEmpty: 'Nothing imported yet.',
  historyRows: (committed: number, total: number): string =>
    `${committed.toLocaleString()} of ${total.toLocaleString()} rows added`,
  historyReversed: 'Undone',
  historyStaged: 'Never finished',
  /** Says the deadline plainly rather than implying undo is always available. */
  historyReversibleUntil: (date: string): string => `Can be undone until ${date}`,
  historyNotReversible: 'Too old to undo',

  rowsSkipped: (count: number): string =>
    `${count.toLocaleString()} row${count === 1 ? '' : 's'} belong to accounts you skipped.`,

  /** Only shown when there is something genuinely unresolved. */
  rowsFailed: (count: number): string =>
    `${count.toLocaleString()} row${count === 1 ? '' : 's'} could not be placed:`,

  commit: 'Add these transactions',
  committing: 'Adding',
  commitFailed: 'Could not add them. Nothing was changed.',
  committed: (count: number): string =>
    `${count} transaction${count === 1 ? '' : 's'} added.`,
  skipped: (count: number): string =>
    count === 0 ? '' : ` ${count} were already present and were skipped.`,

  /** Reversal is the answer to a mistake found later, and it is worth saying it exists. */
  reverse: 'Undo this import',
  reversing: 'Undoing',
  reversed: (count: number): string => `${count} removed.`,
  reverseNote: 'Removes only what this import added. Anything synced or entered by hand is untouched.',

  startOver: 'Import another file',
  /**
   * Counted, not estimated.
   *
   * "Reading" rather than "importing": nothing has been imported at this stage, and a count that
   * implies otherwise makes the later commit look like it ran twice.
   */
  progressReading: (done: number, total: number): string =>
    `Reading ${done.toLocaleString()} of ${total.toLocaleString()} rows`,
  progressCommitting: (done: number, total: number): string =>
    `Adding ${done.toLocaleString()} of ${total.toLocaleString()} transactions`,
} as const
