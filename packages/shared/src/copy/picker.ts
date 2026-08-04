/**
 * The searchable dropdown.
 *
 * Generic on purpose: it is used for accounts today and will be used for anything else that grows
 * past the point where scanning a list is faster than typing. Nothing here names accounts.
 */
export const PICKER_COPY = {
  search: 'Search',
  searchPlaceholder: 'Type to filter',
  /** Distinguishes "your search matched nothing" from "there is nothing here", which look alike. */
  noMatches: 'Nothing matches that',
  empty: 'Nothing to choose from',
} as const
