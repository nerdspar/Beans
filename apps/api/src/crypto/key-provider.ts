import type { DataKey } from './data-key.js'

/**
 * A household DEK as stored in the database: ciphertext plus the master key version that sealed it.
 *
 * The version is what makes rotation possible without downtime — a wrapped DEK always says which
 * master key can open it, so old and new can coexist while re-wrapping proceeds in the background.
 */
export type WrappedDataKey = {
  keyVersion: number
  wrapped: Buffer
}

/**
 * The single seam between Beans and how master keys are held.
 *
 * This is the **one permitted single-implementation abstraction** in the codebase, and it exists
 * for a stated reason (ARCHITECTURE.md §5.1): user-password-derived keys, giving true
 * zero-knowledge, may be wanted later. Keeping that decision contained to one file keeps it a
 * possible future rather than a rewrite. Do not add other speculative interfaces on this pattern.
 *
 * The methods are async even though the current implementation is synchronous — a
 * password-derived or KMS-backed provider would not be, and changing the signature later would
 * ripple through every call site.
 */
export interface KeyProvider {
  /** The version new wraps are sealed with. Rotation raises this. */
  readonly currentKeyVersion: number

  /**
   * Seals a household's DEK for storage.
   *
   * `householdId` is bound as authenticated data, so a wrapped DEK copied into a different
   * household's row will fail to unwrap rather than silently granting access.
   */
  wrapDEK(dek: DataKey, householdId: string): Promise<WrappedDataKey>

  /** Opens a stored DEK. Throws if the key version is unavailable or the household does not match. */
  unwrapDEK(wrapped: WrappedDataKey, householdId: string): Promise<DataKey>
}
