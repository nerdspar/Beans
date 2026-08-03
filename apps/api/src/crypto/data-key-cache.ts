import type { DataKey } from './data-key.js'

export type DataKeyCacheOptions = {
  /** Hard ceiling on resident keys. Bounded so a burst of households cannot grow memory freely. */
  maxEntries?: number
  /** How long an unwrapped key may stay resident. */
  ttlMs?: number
  /**
   * Clock source. Injectable so tests can advance time deterministically — fixtures never use the
   * wall clock (CLAUDE.md).
   */
  now?: () => number
}

type CacheEntry = {
  key: DataKey
  expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 64
const DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * A bounded LRU of unwrapped household DEKs, with a TTL.
 *
 * Unwrapping is cheap, so this is not really a performance cache — it exists to keep plaintext key
 * material resident for as short a time and in as few copies as possible, while avoiding an
 * unwrap on every single column read.
 *
 * The values are {@link DataKey} instances, which redact themselves from logs, JSON, and inspect
 * output. That matters here specifically: a cache of raw Buffers is exactly the object most likely
 * to end up in a heap dump or an error report.
 *
 * **Evicted keys are deliberately not zeroed.** A key handed out to an in-flight request can be
 * evicted while that request is still using it, and zeroing underneath it would produce
 * decryption failures that look like data corruption. Node's GC copies memory anyway, so scrubbing
 * on eviction buys very little for real risk. `DataKey#destroy` remains available for a caller
 * that knows a key is finished with.
 */
export class DataKeyCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #maxEntries: number
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(options: DataKeyCacheOptions = {}) {
    const {
      maxEntries = DEFAULT_MAX_ENTRIES,
      ttlMs = DEFAULT_TTL_MS,
      now = () => Date.now(),
    } = options

    if (maxEntries < 1) {
      throw new Error('DataKeyCache maxEntries must be at least 1')
    }
    if (ttlMs <= 0) {
      throw new Error('DataKeyCache ttlMs must be positive')
    }

    this.#maxEntries = maxEntries
    this.#ttlMs = ttlMs
    this.#now = now
  }

  get(householdId: string): DataKey | undefined {
    const entry = this.#entries.get(householdId)
    if (entry === undefined) {
      return undefined
    }

    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(householdId)
      return undefined
    }

    // Refresh recency. Map preserves insertion order, so re-inserting moves this to the newest
    // position and makes the first entry the least recently used.
    this.#entries.delete(householdId)
    this.#entries.set(householdId, entry)

    return entry.key
  }

  set(householdId: string, key: DataKey): void {
    // Delete first so a re-set moves the entry to the newest position rather than keeping its
    // original insertion order.
    this.#entries.delete(householdId)
    this.#entries.set(householdId, { key, expiresAt: this.#now() + this.#ttlMs })

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) {
        break
      }
      this.#entries.delete(oldest.value)
    }
  }

  /** Drops a household's key. Call when a household's DEK is re-wrapped or its access is revoked. */
  delete(householdId: string): void {
    this.#entries.delete(householdId)
  }

  /** Drops everything. Intended for shutdown and for test isolation. */
  clear(): void {
    this.#entries.clear()
  }

  /** Resident entry count, including any that are expired but not yet evicted. */
  get size(): number {
    return this.#entries.size
  }
}
