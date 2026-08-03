import { readFile } from 'node:fs/promises'
import { DataKey, DEK_LENGTH_BYTES } from './data-key.js'
import { open, seal } from './envelope.js'
import type { KeyProvider, WrappedDataKey } from './key-provider.js'

/**
 * The `KeyProvider` backed by a master key file — a Docker secret mounted into the container and
 * pointed at by `MASTER_KEY_FILE`.
 *
 * The master key never lives in Postgres and never appears inline in the compose file. A stolen
 * database dump is therefore useless on its own, which is the entire point of the design. This
 * also means **the master key must be backed up separately from the database**; a dump without it
 * cannot be restored, and that is stated plainly in the backup documentation.
 */

/**
 * The on-disk format. Multiple versions coexist so the master key can rotate without downtime:
 * new DEKs seal under `currentVersion` while existing DEKs remain readable under whichever version
 * sealed them, until a re-wrap pass moves them all forward.
 *
 * ```json
 * { "currentVersion": 1, "keys": { "1": "<base64 of 32 bytes>" } }
 * ```
 */
type MasterKeyFile = {
  currentVersion: number
  keys: Record<string, string>
}

export class MasterKeyError extends Error {
  override readonly name = 'MasterKeyError'
}

export class LocalMasterKeyProvider implements KeyProvider {
  readonly #keys: ReadonlyMap<number, Buffer>
  readonly currentKeyVersion: number

  private constructor(keys: ReadonlyMap<number, Buffer>, currentKeyVersion: number) {
    this.#keys = keys
    this.currentKeyVersion = currentKeyVersion
  }

  /**
   * Loads and validates the master key file.
   *
   * Validation is strict and happens at startup rather than on first use. A malformed or
   * short key must fail the container's boot, loudly — discovering it on the first write, after
   * the app has been serving for an hour, is far worse.
   */
  static async fromFile(path: string): Promise<LocalMasterKeyProvider> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (cause) {
      throw new MasterKeyError(`Cannot read master key file at ${path}`, { cause })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new MasterKeyError(`Master key file at ${path} is not valid JSON`, { cause })
    }

    return LocalMasterKeyProvider.fromObject(parsed, path)
  }

  /** Exposed separately so tests can build a provider without touching the filesystem. */
  static fromObject(parsed: unknown, source = '<memory>'): LocalMasterKeyProvider {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new MasterKeyError(`Master key file at ${source} must be a JSON object`)
    }

    const { currentVersion, keys } = parsed as Partial<MasterKeyFile>

    if (typeof currentVersion !== 'number' || !Number.isInteger(currentVersion)) {
      throw new MasterKeyError(`Master key file at ${source} is missing an integer currentVersion`)
    }
    if (typeof keys !== 'object' || keys === null) {
      throw new MasterKeyError(`Master key file at ${source} is missing a keys object`)
    }

    const decoded = new Map<number, Buffer>()

    for (const [versionText, encoded] of Object.entries(keys)) {
      const version = Number(versionText)
      if (!Number.isInteger(version)) {
        throw new MasterKeyError(
          `Master key version ${JSON.stringify(versionText)} is not an integer`,
        )
      }
      if (typeof encoded !== 'string') {
        throw new MasterKeyError(`Master key version ${version} must be a base64 string`)
      }

      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length !== DEK_LENGTH_BYTES) {
        // Length is reported because it aids diagnosis and reveals nothing about the key itself.
        throw new MasterKeyError(
          `Master key version ${version} must decode to ${DEK_LENGTH_BYTES} bytes, got ${bytes.length}`,
        )
      }

      decoded.set(version, bytes)
    }

    if (!decoded.has(currentVersion)) {
      throw new MasterKeyError(
        `Master key file at ${source} names currentVersion ${currentVersion}, which is not present in keys`,
      )
    }

    return new LocalMasterKeyProvider(decoded, currentVersion)
  }

  /** Versions available for unwrapping. Used by the re-wrap job and by tests. */
  get availableKeyVersions(): number[] {
    return [...this.#keys.keys()].sort((a, b) => a - b)
  }

  async wrapDEK(dek: DataKey, householdId: string): Promise<WrappedDataKey> {
    const masterKey = this.#requireKey(this.currentKeyVersion)

    return {
      keyVersion: this.currentKeyVersion,
      wrapped: seal(masterKey, dek.bytes, householdId),
    }
  }

  async unwrapDEK(wrapped: WrappedDataKey, householdId: string): Promise<DataKey> {
    const masterKey = this.#requireKey(wrapped.keyVersion)

    return new DataKey(open(masterKey, wrapped.wrapped, householdId))
  }

  #requireKey(version: number): Buffer {
    const key = this.#keys.get(version)
    if (key === undefined) {
      throw new MasterKeyError(
        `No master key for version ${version}. It was likely removed before all DEKs were re-wrapped — ` +
          `restore it, complete the re-wrap, then remove it.`,
      )
    }
    return key
  }
}
