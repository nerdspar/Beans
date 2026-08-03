import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The AES-256-GCM primitive underneath everything encrypted in Beans.
 *
 * Used at two levels: wrapping a household DEK with the master key, and encrypting individual
 * column values with that household's DEK. Both bind the household id as additional authenticated
 * data, so a ciphertext moved between tenants fails authentication rather than decrypting into
 * someone else's row (ARCHITECTURE.md §5).
 */

const ALGORITHM = 'aes-256-gcm'

/**
 * A single leading byte identifying the ciphertext layout. Present so the algorithm can change
 * later without ambiguity about how existing rows were written. Cheap insurance; changing crypto
 * primitives on a database full of data is otherwise miserable.
 */
const FORMAT_VERSION = 1

/** GCM's standard nonce length. Anything else forces a slower construction internally. */
const IV_LENGTH_BYTES = 12
const TAG_LENGTH_BYTES = 16

const VERSION_OFFSET = 0
const IV_OFFSET = 1
const TAG_OFFSET = IV_OFFSET + IV_LENGTH_BYTES
const CIPHERTEXT_OFFSET = TAG_OFFSET + TAG_LENGTH_BYTES

/** Layout: [version:1][iv:12][tag:16][ciphertext:N] */
export const SEALED_OVERHEAD_BYTES = CIPHERTEXT_OFFSET

/**
 * Thrown when a ciphertext fails to authenticate.
 *
 * Deliberately carries no detail about the key, the plaintext, or which check failed. A caller
 * seeing this knows only that the data could not be read with the key and context supplied — which
 * is all they should know, and all that is safe to log.
 */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError'

  constructor(reason: string) {
    super(`Decryption failed: ${reason}`)
  }
}

/**
 * Encrypts `plaintext` under `key`, binding `aad` as authenticated context.
 *
 * A fresh random IV is generated per call. Never reuse an IV with the same key under GCM — it
 * destroys confidentiality, so there is deliberately no way to supply one.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LENGTH_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH_BYTES })

  cipher.setAAD(Buffer.from(aad, 'utf8'))

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([Uint8Array.from([FORMAT_VERSION]), iv, tag, ciphertext])
}

/**
 * Decrypts a value produced by {@link seal}.
 *
 * Throws {@link DecryptionError} if the key is wrong, the `aad` does not match the value it was
 * sealed with, or the ciphertext has been tampered with. These are indistinguishable by design.
 */
export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < CIPHERTEXT_OFFSET) {
    throw new DecryptionError('value is too short to be a sealed ciphertext')
  }

  const version = sealed[VERSION_OFFSET]
  if (version !== FORMAT_VERSION) {
    throw new DecryptionError(`unsupported ciphertext format version ${String(version)}`)
  }

  const iv = sealed.subarray(IV_OFFSET, TAG_OFFSET)
  const tag = sealed.subarray(TAG_OFFSET, CIPHERTEXT_OFFSET)
  const ciphertext = sealed.subarray(CIPHERTEXT_OFFSET)

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH_BYTES })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // Swallow the underlying error deliberately — it can carry key/context detail we must not log.
    throw new DecryptionError('authentication failed')
  }
}
