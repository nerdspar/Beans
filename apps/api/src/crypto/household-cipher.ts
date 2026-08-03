import type { DataKey } from './data-key.js'
import { open, seal } from './envelope.js'

/**
 * Encrypts and decrypts column values for one household.
 *
 * Repositories hold one of these for the duration of a request and use it for every encrypted
 * column. The household id is bound in at construction and passed as authenticated data on every
 * operation, so there is no call site where a caller could forget to scope a value to its tenant —
 * that is the whole reason this is an object rather than a set of free functions.
 *
 * Which columns are encrypted is listed in ARCHITECTURE.md §5. The short version: amounts, names,
 * masks, descriptions, payees, memos, rule match text, and the SimpleFIN access URL. Ids, foreign
 * keys, dates, types, currency codes and boolean flags stay plaintext so they remain indexable.
 */
export class HouseholdCipher {
  readonly #householdId: string
  readonly #dek: DataKey

  constructor(householdId: string, dek: DataKey) {
    if (householdId.length === 0) {
      throw new Error('HouseholdCipher requires a household id to bind as authenticated data')
    }
    this.#householdId = householdId
    this.#dek = dek
  }

  get householdId(): string {
    return this.#householdId
  }

  /**
   * Money. Serialized as the bigint's exact base-10 form — never through a `number`, and never
   * through a float (ARCHITECTURE.md §3).
   */
  encryptMoney(cents: bigint): Buffer {
    return this.#seal(Buffer.from(cents.toString(), 'utf8'))
  }

  decryptMoney(sealed: Buffer): bigint {
    const text = this.#open(sealed).toString('utf8')

    // GCM authentication already proves this is what we wrote, so a failure here means a bug in
    // the writer rather than tampering. Still worth catching explicitly: BigInt('') is 0n, which
    // would silently turn corruption into a plausible-looking zero balance.
    if (!/^-?\d+$/.test(text)) {
      throw new Error('Decrypted money value is not a valid integer amount')
    }

    return BigInt(text)
  }

  encryptText(value: string): Buffer {
    return this.#seal(Buffer.from(value, 'utf8'))
  }

  decryptText(sealed: Buffer): string {
    return this.#open(sealed).toString('utf8')
  }

  /** For staged import payloads, which are JSONB and encrypted whole. */
  encryptJson(value: unknown): Buffer {
    return this.#seal(Buffer.from(JSON.stringify(value), 'utf8'))
  }

  decryptJson<T>(sealed: Buffer): T {
    return JSON.parse(this.#open(sealed).toString('utf8')) as T
  }

  /**
   * Nullable variants. Plenty of encrypted columns are optional (memo, mask, available balance),
   * and `null` passes through untouched rather than becoming the ciphertext of `"null"` — that
   * keeps "absent" distinguishable from "present and empty" at the database level.
   */
  encryptTextOrNull(value: string | null): Buffer | null {
    return value === null ? null : this.encryptText(value)
  }

  decryptTextOrNull(sealed: Buffer | null): string | null {
    return sealed === null ? null : this.decryptText(sealed)
  }

  encryptMoneyOrNull(cents: bigint | null): Buffer | null {
    return cents === null ? null : this.encryptMoney(cents)
  }

  decryptMoneyOrNull(sealed: Buffer | null): bigint | null {
    return sealed === null ? null : this.decryptMoney(sealed)
  }

  #seal(plaintext: Buffer): Buffer {
    return seal(this.#dek.bytes, plaintext, this.#householdId)
  }

  #open(sealed: Buffer): Buffer {
    return open(this.#dek.bytes, sealed, this.#householdId)
  }

  toJSON(): string {
    return '[redacted HouseholdCipher]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `HouseholdCipher(${this.#householdId}) [key redacted]`
  }
}
