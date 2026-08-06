import { type Preferences } from '@beans/shared'

/**
 * Reading and writing one user's interface preferences.
 *
 * Extracted from the route, both because SQL belongs here and because the bug that prompted it was
 * untestable where it was: the upsert handed a JavaScript array to a `jsonb` column, node-pg
 * serialized it as a Postgres array literal, and Postgres rejected it. Every save of a navigation
 * order failed, at any length, from the first one. A test of a *copy* of that SQL would have proved
 * nothing — the defect was in the statement the route actually ran.
 *
 * User-scoped rather than household-scoped, which is why this takes a query function rather than a
 * `HouseholdContext`: `user_preferences` is the one table whose RLS keys on `app.current_user_id`.
 */

export type QueryFn = <T extends Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>

/** What an absent row means: the shipped defaults, not an error. */
export const PREFERENCE_DEFAULTS: Preferences = {
  tabOrder: null,
  theme: 'system',
  /** Shown by default — the alternative discards real history, which nobody should get unasked. */
  showIncompleteHistory: true,
}

export async function readPreferences(query: QueryFn, userId: string): Promise<Preferences> {
  const result = await query<{
    tab_order: string[] | null
    theme: string
    show_incomplete_history: boolean
  }>('select tab_order, theme, show_incomplete_history from user_preferences where user_id = $1', [
    userId,
  ])

  const row = result.rows[0]
  if (row === undefined) return PREFERENCE_DEFAULTS

  return {
    // jsonb comes back parsed, so this is already an array. Only the write needed serializing.
    tabOrder: row.tab_order,
    theme: row.theme as Preferences['theme'],
    showIncompleteHistory: row.show_incomplete_history,
  }
}

export type PreferencePatch = {
  /** Present and null clears it; absent leaves it alone. The two are different operations. */
  tabOrder?: string[] | null | undefined
  theme?: Preferences['theme'] | undefined
  showIncompleteHistory?: boolean | undefined
}

export async function writePreferences(
  query: QueryFn,
  userId: string,
  patch: PreferencePatch,
): Promise<void> {
  /*
   * **Serialized, because the column is `jsonb`.**
   *
   * node-pg turns a JavaScript array into Postgres array-literal syntax — `{a,b,c}` — and offers
   * that to a json column, which refuses it: `invalid input syntax for type json`. So the statement
   * threw on every save, and had since the feature shipped.
   *
   * It was invisible from both ends: the route returned 500, and the client did not check the
   * response status, so its optimistic update simply rolled back on the next refetch. On screen
   * that is a row that moves and moves back — which reads as a button that does nothing rather than
   * a write that failed.
   *
   * `null` stays null rather than becoming the string "null". Clearing the preference is a real
   * operation, and `JSON.stringify(null)` would store a JSON null that reads back as a value where
   * an absence is meant.
   */
  const tabOrder =
    patch.tabOrder === undefined || patch.tabOrder === null ? null : JSON.stringify(patch.tabOrder)

  await query(
    /*
     * Upsert rather than update: a user has no preferences row until they change something, and
     * creating one at signup would mean every path that creates a user has to remember.
     *
     * The stored keys are deliberately not validated against the destination registry — that list
     * lives in the frontend and changes with it. Unknown keys are dropped when the preference is
     * resolved, so a stale one degrades to the default rather than breaking navigation.
     */
    `insert into user_preferences (user_id, tab_order, theme, show_incomplete_history)
     values ($1, $2, coalesce($3, 'system'), coalesce($4, true))
     on conflict (user_id) do update
       set tab_order = case
             when $5 then excluded.tab_order
             else user_preferences.tab_order
           end,
           theme = coalesce($3, user_preferences.theme),
           show_incomplete_history =
             coalesce($4, user_preferences.show_incomplete_history)`,
    [
      userId,
      tabOrder,
      patch.theme ?? null,
      patch.showIncompleteHistory ?? null,
      // Distinguishes "clear the tab order" from "leave it alone" — both arrive as null above.
      'tabOrder' in patch,
    ],
  )
}
