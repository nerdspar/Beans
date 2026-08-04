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
  rowsParsed: (parsed: number, total: number): string =>
    parsed === total
      ? `${total} row${total === 1 ? '' : 's'} read.`
      : `${parsed} of ${total} rows read. The rest could not be parsed and will be skipped.`,

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
} as const
