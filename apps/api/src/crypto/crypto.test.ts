import { describe, expect, it } from 'vitest'
import { DataKey } from './data-key.js'
import { DataKeyCache } from './data-key-cache.js'
import { DecryptionError, open, seal } from './envelope.js'
import { HouseholdCipher } from './household-cipher.js'
import { LocalMasterKeyProvider, MasterKeyError } from './local-master-key-provider.js'

// Fixed key material. Deterministic fixtures only — never random or clock-derived (CLAUDE.md).
const MASTER_KEY_V1 = Buffer.alloc(32, 0x11).toString('base64')
const MASTER_KEY_V2 = Buffer.alloc(32, 0x22).toString('base64')

const HOUSEHOLD_A = '11111111-1111-4111-8111-111111111111'
const HOUSEHOLD_B = '22222222-2222-4222-8222-222222222222'

const providerV1 = () =>
  LocalMasterKeyProvider.fromObject({ currentVersion: 1, keys: { 1: MASTER_KEY_V1 } })

const providerV2 = () =>
  LocalMasterKeyProvider.fromObject({
    currentVersion: 2,
    keys: { 1: MASTER_KEY_V1, 2: MASTER_KEY_V2 },
  })

const fixedDek = () => new DataKey(Buffer.alloc(32, 0xab))

/** Returns a copy with one byte inverted, for tamper-detection tests. */
const flipByte = (buffer: Buffer, index: number): Buffer => {
  const copy = Buffer.from(buffer)
  copy[index] = (copy[index] ?? 0) ^ 0xff
  return copy
}

describe('DataKey', () => {
  it('requires exactly 32 bytes', () => {
    expect(() => new DataKey(Buffer.alloc(16))).toThrow(/32 bytes/)
    expect(() => new DataKey(Buffer.alloc(64))).toThrow(/32 bytes/)
    expect(() => new DataKey(Buffer.alloc(32))).not.toThrow()
  })

  it('generates distinct random keys', () => {
    expect(DataKey.generate().equals(DataKey.generate())).toBe(false)
  })

  it('copies its input so later mutation cannot corrupt it', () => {
    const source = Buffer.alloc(32, 0x01)
    const key = new DataKey(source)
    source.fill(0xff)
    expect(key.bytes.equals(Buffer.alloc(32, 0x01))).toBe(true)
  })

  describe('never leaks key material through an ordinary output path', () => {
    const key = new DataKey(Buffer.alloc(32, 0xab))
    const secret = 'ab'.repeat(32)

    it('is redacted by JSON.stringify', () => {
      const serialized = JSON.stringify({ dek: key })
      expect(serialized).toContain('redacted')
      expect(serialized).not.toContain(secret)
    })

    it('is redacted by string interpolation', () => {
      expect(`${key}`).not.toContain(secret)
    })

    it('is redacted by node inspect, which is what loggers use', async () => {
      const { inspect } = await import('node:util')
      expect(inspect({ dek: key })).not.toContain(secret)
      expect(inspect({ dek: key })).toContain('redacted')
    })
  })
})

describe('envelope', () => {
  const key = Buffer.alloc(32, 0x05)

  it('round trips', () => {
    const plaintext = Buffer.from('Adv Relationship Banking', 'utf8')
    expect(open(key, seal(key, plaintext, HOUSEHOLD_A), HOUSEHOLD_A).equals(plaintext)).toBe(true)
  })

  it('round trips an empty value', () => {
    const sealed = seal(key, Buffer.alloc(0), HOUSEHOLD_A)
    expect(open(key, sealed, HOUSEHOLD_A).length).toBe(0)
  })

  it('produces a different ciphertext each time, from a fresh IV', () => {
    const plaintext = Buffer.from('same input', 'utf8')
    const first = seal(key, plaintext, HOUSEHOLD_A)
    const second = seal(key, plaintext, HOUSEHOLD_A)

    expect(first.equals(second)).toBe(false)
    // ...but both still decrypt to the same thing.
    expect(open(key, first, HOUSEHOLD_A).equals(open(key, second, HOUSEHOLD_A))).toBe(true)
  })

  it('does not leave the plaintext visible in the ciphertext', () => {
    const sealed = seal(key, Buffer.from('Whole Foods Market', 'utf8'), HOUSEHOLD_A)
    expect(sealed.toString('utf8')).not.toContain('Whole Foods')
  })

  it('rejects a wrong key', () => {
    const sealed = seal(key, Buffer.from('x'), HOUSEHOLD_A)
    expect(() => open(Buffer.alloc(32, 0x06), sealed, HOUSEHOLD_A)).toThrow(DecryptionError)
  })

  it('rejects tampering with the ciphertext', () => {
    const sealed = seal(key, Buffer.from('balance', 'utf8'), HOUSEHOLD_A)
    const tampered = flipByte(sealed, sealed.length - 1)

    expect(() => open(key, tampered, HOUSEHOLD_A)).toThrow(DecryptionError)
  })

  it('rejects tampering with the auth tag', () => {
    const sealed = seal(key, Buffer.from('balance', 'utf8'), HOUSEHOLD_A)
    const tampered = flipByte(sealed, 14) // inside the tag

    expect(() => open(key, tampered, HOUSEHOLD_A)).toThrow(DecryptionError)
  })

  it('rejects an unknown format version', () => {
    const sealed = seal(key, Buffer.from('x'), HOUSEHOLD_A)
    const tampered = Buffer.from(sealed)
    tampered[0] = 99

    expect(() => open(key, tampered, HOUSEHOLD_A)).toThrow(/format version/)
  })

  it('rejects a truncated value', () => {
    expect(() => open(key, Buffer.alloc(4), HOUSEHOLD_A)).toThrow(/too short/)
  })

  it('never reveals the reason in a way that distinguishes wrong key from tampering', () => {
    const sealed = seal(key, Buffer.from('x'), HOUSEHOLD_A)
    const tampered = flipByte(sealed, sealed.length - 1)

    const wrongKeyMessage = (() => {
      try {
        open(Buffer.alloc(32, 0x06), sealed, HOUSEHOLD_A)
        return null
      } catch (error) {
        return (error as Error).message
      }
    })()

    const tamperedMessage = (() => {
      try {
        open(key, tampered, HOUSEHOLD_A)
        return null
      } catch (error) {
        return (error as Error).message
      }
    })()

    expect(wrongKeyMessage).toBe(tamperedMessage)
  })
})

describe('AAD binds a value to its household', () => {
  const key = Buffer.alloc(32, 0x07)

  it('refuses to open a value sealed for a different household', () => {
    const sealed = seal(key, Buffer.from('-82487123', 'utf8'), HOUSEHOLD_A)

    // The exact attack this defends against: lifting a ciphertext row from one tenant into
    // another. Even with the correct key, it must not decrypt.
    expect(() => open(key, sealed, HOUSEHOLD_B)).toThrow(DecryptionError)
  })

  it('refuses across households at the cipher level too', () => {
    const dek = fixedDek()
    const cipherA = new HouseholdCipher(HOUSEHOLD_A, dek)
    const cipherB = new HouseholdCipher(HOUSEHOLD_B, dek)

    const sealed = cipherA.encryptMoney(-82487123n)

    expect(() => cipherB.decryptMoney(sealed)).toThrow(DecryptionError)
    expect(cipherA.decryptMoney(sealed)).toBe(-82487123n)
  })

  it('requires a household id', () => {
    expect(() => new HouseholdCipher('', fixedDek())).toThrow(/household id/)
  })
})

describe('HouseholdCipher round trips every encrypted column type', () => {
  const cipher = new HouseholdCipher(HOUSEHOLD_A, fixedDek())

  describe('money', () => {
    it.each([
      ['zero', 0n],
      ['a cent', 1n],
      ['a cash balance', 30189573n],
      ['a negative liability', -82487123n],
      ['a large asset', 262001253n],
      ['beyond Number.MAX_SAFE_INTEGER', 9007199254740993n],
      ['deeply negative', -9007199254740993n],
    ])('round trips %s', (_label, cents) => {
      expect(cipher.decryptMoney(cipher.encryptMoney(cents))).toBe(cents)
    })

    it('rejects a decrypted value that is not an integer amount', () => {
      // Simulates a writer bug rather than tampering: BigInt('') is 0n, which would otherwise
      // turn corruption into a plausible-looking zero balance.
      const badlyWritten = cipher.encryptText('')
      expect(() => cipher.decryptMoney(badlyWritten)).toThrow(/not a valid integer amount/)
    })
  })

  describe('text', () => {
    it.each([
      ['an account display name', 'Joint Automated Investing Account'],
      ['a provider name', 'Adv Relationship Banking'],
      ['an account mask', '4821'],
      ['a transaction description', 'AMAZON MARKETPLACE*2A4XY9 AMZN.COM/BILL WA'],
      ['a payee', 'Whole Foods Market'],
      ['a memo with punctuation', "Kid's tuition — Aug '26 (installment 2/10)"],
      ['a SimpleFIN access URL', 'https://user:pass@bridge.simplefin.org/simplefin'],
      ['an empty string', ''],
      ['unicode', 'Café Münchener 日本語 🫘'],
      ['a long value', 'x'.repeat(5000)],
    ])('round trips %s', (_label, value) => {
      expect(cipher.decryptText(cipher.encryptText(value))).toBe(value)
    })
  })

  describe('json, for staged import rows', () => {
    it('round trips a parsed import row', () => {
      const row = {
        date: '2019-03-14',
        description: 'TRADER JOE&#39;S #512',
        amount: '-84.23',
        category: 'Groceries',
        nested: { account: 'Checking', tags: ['food', 'weekly'] },
      }
      expect(cipher.decryptJson(cipher.encryptJson(row))).toEqual(row)
    })

    it('round trips an array', () => {
      expect(cipher.decryptJson(cipher.encryptJson([1, 'two', null]))).toEqual([1, 'two', null])
    })
  })

  describe('nullable columns', () => {
    it('passes null through untouched rather than encrypting the string "null"', () => {
      expect(cipher.encryptTextOrNull(null)).toBeNull()
      expect(cipher.encryptMoneyOrNull(null)).toBeNull()
      expect(cipher.decryptTextOrNull(null)).toBeNull()
      expect(cipher.decryptMoneyOrNull(null)).toBeNull()
    })

    it('keeps absent distinguishable from present-but-empty', () => {
      expect(cipher.encryptTextOrNull(null)).toBeNull()
      expect(cipher.encryptTextOrNull('')).not.toBeNull()
      expect(cipher.decryptTextOrNull(cipher.encryptTextOrNull(''))).toBe('')
    })

    it('round trips present values', () => {
      expect(cipher.decryptTextOrNull(cipher.encryptTextOrNull('Chase'))).toBe('Chase')
      expect(cipher.decryptMoneyOrNull(cipher.encryptMoneyOrNull(-338639n))).toBe(-338639n)
    })
  })

  it('redacts itself from logs', () => {
    expect(JSON.stringify({ cipher })).toContain('redacted')
  })
})

describe('LocalMasterKeyProvider', () => {
  it('wraps and unwraps a DEK', async () => {
    const provider = providerV1()
    const dek = DataKey.generate()

    const wrapped = await provider.wrapDEK(dek, HOUSEHOLD_A)
    const unwrapped = await provider.unwrapDEK(wrapped, HOUSEHOLD_A)

    expect(unwrapped.equals(dek)).toBe(true)
    expect(wrapped.keyVersion).toBe(1)
  })

  it('does not store the DEK in the clear', async () => {
    const provider = providerV1()
    const dek = new DataKey(Buffer.alloc(32, 0xcd))
    const { wrapped } = await provider.wrapDEK(dek, HOUSEHOLD_A)

    expect(wrapped.includes(Buffer.alloc(32, 0xcd))).toBe(false)
  })

  it('binds the wrapped DEK to its household', async () => {
    const provider = providerV1()
    const wrapped = await provider.wrapDEK(DataKey.generate(), HOUSEHOLD_A)

    // A wrapped DEK copied into another household's row must not open.
    await expect(provider.unwrapDEK(wrapped, HOUSEHOLD_B)).rejects.toThrow(DecryptionError)
  })

  describe('validation at load time', () => {
    it.each([
      ['not an object', 'nope'],
      ['null', null],
      ['missing currentVersion', { keys: { 1: MASTER_KEY_V1 } }],
      ['non-integer currentVersion', { currentVersion: 1.5, keys: { 1: MASTER_KEY_V1 } }],
      ['missing keys', { currentVersion: 1 }],
      ['a key that is too short', { currentVersion: 1, keys: { 1: 'c2hvcnQ=' } }],
      ['a non-string key', { currentVersion: 1, keys: { 1: 42 } }],
      ['currentVersion absent from keys', { currentVersion: 3, keys: { 1: MASTER_KEY_V1 } }],
    ])('rejects %s', (_label, input) => {
      expect(() => LocalMasterKeyProvider.fromObject(input)).toThrow(MasterKeyError)
    })

    it('fails on a missing file rather than starting up degraded', async () => {
      await expect(LocalMasterKeyProvider.fromFile('/nonexistent/master.key')).rejects.toThrow(
        MasterKeyError,
      )
    })

    it('loads a key file produced by the generator script', async () => {
      // Closes the loop between `pnpm generate:master-key` and this provider. If the script's
      // output format and the loader ever drift apart, the symptom is a container that will not
      // boot — worth catching here instead.
      const { execFileSync } = await import('node:child_process')
      const { mkdtemp, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { fileURLToPath } = await import('node:url')

      const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
      const scriptPath = join(repoRoot, 'scripts', 'generate-master-key.mjs')

      const generated = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' })
      const directory = await mkdtemp(join(tmpdir(), 'beans-key-'))
      const keyPath = join(directory, 'master.key')
      await writeFile(keyPath, generated)

      const provider = await LocalMasterKeyProvider.fromFile(keyPath)
      expect(provider.currentKeyVersion).toBe(1)

      // And it actually works, rather than merely parsing.
      const dek = DataKey.generate()
      const wrapped = await provider.wrapDEK(dek, HOUSEHOLD_A)
      expect((await provider.unwrapDEK(wrapped, HOUSEHOLD_A)).equals(dek)).toBe(true)
    })

    it('reports the expected length without echoing the key', () => {
      try {
        LocalMasterKeyProvider.fromObject({ currentVersion: 1, keys: { 1: 'c2hvcnQ=' } })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect((error as Error).message).toMatch(/32 bytes/)
        expect((error as Error).message).not.toContain('c2hvcnQ=')
      }
    })
  })
})

describe('master key rotation preserves readability of old rows', () => {
  it('reads data sealed under v1 after rotating to v2', async () => {
    // 1. A household exists under master key v1, with encrypted data.
    const v1 = providerV1()
    const dek = DataKey.generate()
    const wrappedUnderV1 = await v1.wrapDEK(dek, HOUSEHOLD_A)

    const cipher = new HouseholdCipher(HOUSEHOLD_A, dek)
    const sealedBalance = cipher.encryptMoney(-82487123n)
    const sealedName = cipher.encryptText('NewRez')

    // 2. The master key rotates. v2 becomes current; v1 is retained for unwrapping.
    const v2 = providerV2()
    expect(v2.currentKeyVersion).toBe(2)
    expect(v2.availableKeyVersions).toEqual([1, 2])

    // 3. The old wrapped DEK still opens, so no row becomes unreadable at the moment of rotation.
    const recovered = await v2.unwrapDEK(wrappedUnderV1, HOUSEHOLD_A)
    expect(recovered.equals(dek)).toBe(true)

    const recoveredCipher = new HouseholdCipher(HOUSEHOLD_A, recovered)
    expect(recoveredCipher.decryptMoney(sealedBalance)).toBe(-82487123n)
    expect(recoveredCipher.decryptText(sealedName)).toBe('NewRez')
  })

  it('re-wraps under the new version without touching row data', async () => {
    const v1 = providerV1()
    const dek = DataKey.generate()
    const wrappedUnderV1 = await v1.wrapDEK(dek, HOUSEHOLD_A)

    const cipher = new HouseholdCipher(HOUSEHOLD_A, dek)
    const sealedBalance = cipher.encryptMoney(30189573n)

    const v2 = providerV2()

    // The re-wrap pass: unwrap with the old version, wrap with the new. The DEK is unchanged, so
    // not a single encrypted column has to be rewritten.
    const recovered = await v2.unwrapDEK(wrappedUnderV1, HOUSEHOLD_A)
    const wrappedUnderV2 = await v2.wrapDEK(recovered, HOUSEHOLD_A)

    expect(wrappedUnderV2.keyVersion).toBe(2)
    expect(wrappedUnderV2.wrapped.equals(wrappedUnderV1.wrapped)).toBe(false)

    const afterRewrap = await v2.unwrapDEK(wrappedUnderV2, HOUSEHOLD_A)
    expect(new HouseholdCipher(HOUSEHOLD_A, afterRewrap).decryptMoney(sealedBalance)).toBe(
      30189573n,
    )
  })

  it('fails loudly if an old master key is removed before re-wrapping finished', async () => {
    const v1 = providerV1()
    const wrappedUnderV1 = await v1.wrapDEK(DataKey.generate(), HOUSEHOLD_A)

    // v2 only — someone pruned v1 too early. This is data loss if it goes unnoticed, so the error
    // must name the cause and the recovery.
    const v2Only = LocalMasterKeyProvider.fromObject({
      currentVersion: 2,
      keys: { 2: MASTER_KEY_V2 },
    })

    await expect(v2Only.unwrapDEK(wrappedUnderV1, HOUSEHOLD_A)).rejects.toThrow(
      /No master key for version 1.*re-wrap/s,
    )
  })
})

describe('DataKeyCache', () => {
  /** Deterministic clock. Tests never read the wall clock. */
  const clock = () => {
    let current = 1_000_000
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms
      },
    }
  }

  it('stores and returns a key', () => {
    const cache = new DataKeyCache({ now: clock().now })
    const key = fixedDek()

    cache.set(HOUSEHOLD_A, key)
    expect(cache.get(HOUSEHOLD_A)).toBe(key)
  })

  it('returns undefined for an unknown household', () => {
    expect(new DataKeyCache().get(HOUSEHOLD_A)).toBeUndefined()
  })

  it('expires entries after the TTL', () => {
    const time = clock()
    const cache = new DataKeyCache({ ttlMs: 1000, now: time.now })

    cache.set(HOUSEHOLD_A, fixedDek())
    time.advance(999)
    expect(cache.get(HOUSEHOLD_A)).toBeDefined()

    time.advance(1)
    expect(cache.get(HOUSEHOLD_A)).toBeUndefined()
  })

  it('evicts the least recently used entry past capacity', () => {
    const cache = new DataKeyCache({ maxEntries: 2, now: clock().now })

    cache.set('a', fixedDek())
    cache.set('b', fixedDek())
    cache.get('a') // 'a' becomes most recent, so 'b' is now the eviction candidate
    cache.set('c', fixedDek())

    expect(cache.get('a')).toBeDefined()
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBeDefined()
    expect(cache.size).toBe(2)
  })

  it('never grows beyond its bound', () => {
    const cache = new DataKeyCache({ maxEntries: 3, now: clock().now })
    for (let i = 0; i < 100; i += 1) {
      cache.set(`household-${i}`, fixedDek())
    }
    expect(cache.size).toBe(3)
  })

  it('re-setting a household refreshes it rather than duplicating', () => {
    const cache = new DataKeyCache({ maxEntries: 2, now: clock().now })
    const replacement = fixedDek()

    cache.set('a', fixedDek())
    cache.set('b', fixedDek())
    cache.set('a', replacement)
    cache.set('c', fixedDek())

    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBe(replacement)
    expect(cache.get('b')).toBeUndefined()
  })

  it('drops a single household on demand', () => {
    const cache = new DataKeyCache({ now: clock().now })
    cache.set(HOUSEHOLD_A, fixedDek())
    cache.set(HOUSEHOLD_B, fixedDek())

    cache.delete(HOUSEHOLD_A)

    expect(cache.get(HOUSEHOLD_A)).toBeUndefined()
    expect(cache.get(HOUSEHOLD_B)).toBeDefined()
  })

  it('clears everything for shutdown', () => {
    const cache = new DataKeyCache({ now: clock().now })
    cache.set(HOUSEHOLD_A, fixedDek())
    cache.set(HOUSEHOLD_B, fixedDek())

    cache.clear()

    expect(cache.size).toBe(0)
  })

  it('rejects a nonsensical configuration', () => {
    expect(() => new DataKeyCache({ maxEntries: 0 })).toThrow(/at least 1/)
    expect(() => new DataKeyCache({ ttlMs: 0 })).toThrow(/positive/)
  })
})
