import { randomBytes, timingSafeEqual } from 'node:crypto'

/** AES-256 needs exactly 32 bytes. */
export const DEK_LENGTH_BYTES = 32

/**
 * A household's unwrapped data encryption key.
 *
 * This is a wrapper rather than a bare Buffer for one reason: an unwrapped DEK must never be
 * logged, serialized, or included in error reporting (ARCHITECTURE.md §5). A `Buffer` happily
 * renders itself into `JSON.stringify`, `console.log`, and structured logger output. This class
 * makes all three paths produce a redaction marker instead, so leaking a key requires deliberately
 * reaching for `.bytes` rather than merely being careless with a log line.
 */
export class DataKey {
  readonly #bytes: Buffer

  constructor(bytes: Buffer) {
    if (bytes.length !== DEK_LENGTH_BYTES) {
      throw new Error(`DEK must be exactly ${DEK_LENGTH_BYTES} bytes, received ${bytes.length}`)
    }
    // Copy so a caller mutating (or zeroing) their buffer cannot corrupt this key.
    this.#bytes = Buffer.from(bytes)
  }

  /** Generates a fresh random DEK. Used once per household, at creation. */
  static generate(): DataKey {
    return new DataKey(randomBytes(DEK_LENGTH_BYTES))
  }

  /**
   * The raw key material. Only the crypto layer should ever call this — everything else should
   * pass the `DataKey` around intact.
   */
  get bytes(): Buffer {
    return this.#bytes
  }

  /** Constant-time comparison. Used by tests and key rotation checks, never in a hot path. */
  equals(other: DataKey): boolean {
    return timingSafeEqual(this.#bytes, other.#bytes)
  }

  /**
   * Best-effort zeroing when a key is evicted from cache. Node may have copied the bytes during
   * GC, so this reduces the window rather than eliminating it.
   */
  destroy(): void {
    this.#bytes.fill(0)
  }

  toJSON(): string {
    return '[redacted DataKey]'
  }

  toString(): string {
    return '[redacted DataKey]'
  }

  /** Covers `console.log` and anything else using Node's inspect protocol. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'DataKey [redacted]'
  }
}
