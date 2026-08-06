/**
 * Copy for the app shell — the parts that are there on every screen.
 *
 * All of it is navigational, so all of it is plain. These are the words someone uses to find their
 * way when they cannot see the layout, and a voice in them costs comprehension for nothing.
 */

export const SHELL_COPY = {
  /**
   * The skip link, revealed by the first Tab on any screen.
   *
   * "Content" rather than "main content" or "main": it is what the link does, in the fewest words,
   * and it is heard before the reader knows what this app's regions are called.
   */
  skipToContent: 'Skip to content',

  /**
   * Names the `<main>` landmark.
   *
   * A screen reader lists landmarks by name, and two unnamed regions in that list are no help. This
   * is the one a reader jumps to.
   */
  mainRegion: 'Main content',

  /** Names the overflow sheet's contents, which are otherwise an unexplained list. */
  moreSheetDescription: 'Everything not shown in the tab bar.',

  /**
   * A URL that matches nothing.
   *
   * Light, because nothing has gone wrong with anyone's money — a mistyped path is the one failure
   * in Beans where the stakes really are zero, and the copy rules allow a voice in exactly these
   * states. It still says plainly what happened, because "Nothing here" alone is a shrug.
   */
  notFound: 'Nothing here',
  notFoundDetail: 'That page does not exist.',

  /**
   * A screen that threw while rendering.
   *
   * Emphatically **not** light. Something is broken, the reader cannot see their numbers, and they
   * do not yet know whether their data is affected — so the first job is to say that nothing was
   * changed, and the second is to say what to do next. Beans is self-hosted, which means the person
   * reading this is very often the person who can fix it.
   */
  screenFailed: 'This screen could not be shown',
  screenFailedDetail:
    'Nothing was changed, and the rest of Beans still works. Moving to another tab and back will try again.',
} as const
