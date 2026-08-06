/**
 * A file chosen on one screen, opened on another.
 *
 * The import entry point on Manage accounts is a real file input, so the first click opens the file
 * dialog — which is what a button saying "Choose a file" should do. The wizard that reads it lives
 * at `/import`, because column mapping and a forty-account matching table need the room. So the
 * file has to survive one client-side navigation.
 *
 * A module variable rather than storage, deliberately. `sessionStorage` caps around 5MB and the
 * import route accepts 10, so a large export would fail to stash and fail silently at that. This
 * holds a reference, costs nothing, and is gone on reload — which is the correct lifetime: a
 * reloaded import page should ask for the file again rather than resurrect one from a previous
 * visit that the reader has no reason to expect.
 *
 * Consumed on read, so arriving at `/import` a second time starts clean rather than re-importing
 * whatever was chosen before.
 */

let pending: File | null = null

export function setPendingImportFile(file: File): void {
  pending = file
}

/** Returns the pending file and clears it. Null when the page was reached directly. */
export function takePendingImportFile(): File | null {
  const file = pending
  pending = null
  return file
}
