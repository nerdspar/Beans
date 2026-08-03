import { hash, verify } from '@node-rs/argon2'

/**
 * `Algorithm.Argon2id`, inlined as its numeric value.
 *
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which is erased at compile
 * time and has no runtime export — so importing it as a value fails under `verbatimModuleSyntax`.
 * The value is part of the library's public API and pinned by its own type, so a wrong number
 * would not compile.
 */
const ARGON2ID = 2

/**
 * Argon2id password hashing.
 *
 * Better Auth defaults to **scrypt**, chosen because Node supports it natively. The spec calls for
 * Argon2id, which is OWASP's first recommendation, so it is configured explicitly.
 *
 * **This had to be decided before any user existed.** Existing scrypt hashes would not verify
 * under an Argon2-only verifier, so switching later means either a dual-path verifier that sniffs
 * the hash prefix, or forcing every user through a password reset. Beans is greenfield, so it gets
 * the right answer for free — do not change the algorithm once real accounts exist without
 * planning that migration.
 */

/**
 * OWASP's recommended Argon2id baseline: 64 MiB, 3 iterations, parallelism 4.
 *
 * Memory cost is the parameter that actually resists GPU cracking, which is why it is high
 * relative to the iteration count. Raising it further is reasonable on capable hardware; note it
 * is charged per concurrent login, so it is also a denial-of-service surface if pushed absurdly.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
} as const

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

export async function verifyPassword({
  password,
  hash: stored,
}: {
  password: string
  hash: string
}): Promise<boolean> {
  try {
    return await verify(stored, password, OPTIONS)
  } catch {
    // A malformed or foreign-format hash is a failed verification, not a crash. Returning false
    // keeps the failure indistinguishable from a wrong password, which is what a caller should
    // see either way.
    return false
  }
}
