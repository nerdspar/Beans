/**
 * Limits the API and the web app have to agree on.
 *
 * This exists because they did not. The navigation order was capped at eight in the API's request
 * schema, chosen when the settings screen offered only the six destinations eligible for the bottom
 * bar. When the screen grew to cover all ten, every save it made was rejected — and because the
 * client did not check the response status, the rejection surfaced as rows that swapped places and
 * swapped back with nothing said.
 *
 * A number one side enforces and the other has to guess is the definition of what belongs here.
 */

/**
 * How many entries a stored navigation order may carry.
 *
 * A payload bound, not a rule about navigation: `resolveNavigationOrder` in the web app ignores keys
 * it does not recognise and de-duplicates the rest, so nothing downstream trusts the contents. The
 * only job here is refusing an unreasonable body.
 *
 * Generous on purpose. It has to exceed the number of destinations — with room for the ones added
 * later, since the failure when it does not is silent on the server and mystifying on the client.
 */
export const MAX_TAB_ORDER_LENGTH = 32

/** The shape both sides exchange. Kept here so the route and the hook cannot disagree about it. */
export type Preferences = {
  /** The reader's navigation order, or null for "no preference — use the shipped default". */
  tabOrder: string[] | null
  theme: 'light' | 'dark' | 'system'
  /** Whether net worth is drawn back to the earliest account, or only where every account reaches. */
  showIncompleteHistory: boolean
}
