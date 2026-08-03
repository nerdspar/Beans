#!/usr/bin/env node
/**
 * Generates a master key file, or adds a new version to an existing one for rotation.
 *
 *   Create:  mkdir -p secrets && pnpm generate:master-key > secrets/master.key
 *   Rotate:  pnpm generate:master-key --rotate secrets/master.key > secrets/master.key.new
 *
 * Output goes to stdout so the key never lands anywhere it wasn't explicitly redirected — no
 * temp file, no shell history, no accidental commit.
 *
 * *** BACK THE RESULT UP SEPARATELY FROM THE DATABASE. ***
 * A Postgres dump without this file is permanently unreadable.
 *
 * Rotation is deliberately non-destructive: the previous version is retained so existing wrapped
 * DEKs stay readable while a background pass re-wraps them. Removing an old key before that pass
 * finishes makes every household's data unreadable — see LocalMasterKeyProvider.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const KEY_LENGTH_BYTES = 32

const args = process.argv.slice(2)
const rotateIndex = args.indexOf('--rotate')

const newKey = randomBytes(KEY_LENGTH_BYTES).toString('base64')

if (rotateIndex === -1) {
  process.stdout.write(`${JSON.stringify({ currentVersion: 1, keys: { 1: newKey } }, null, 2)}\n`)
  process.exit(0)
}

const path = args[rotateIndex + 1]
if (path === undefined) {
  process.stderr.write('Usage: generate-master-key.mjs --rotate <path-to-existing-key-file>\n')
  process.exit(1)
}

let existing
try {
  existing = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  process.stderr.write(`Cannot read existing master key file at ${path}: ${error.message}\n`)
  process.exit(1)
}

if (typeof existing?.currentVersion !== 'number' || typeof existing?.keys !== 'object') {
  process.stderr.write(`${path} is not a valid master key file\n`)
  process.exit(1)
}

const nextVersion = Math.max(...Object.keys(existing.keys).map(Number)) + 1

process.stdout.write(
  `${JSON.stringify(
    { currentVersion: nextVersion, keys: { ...existing.keys, [nextVersion]: newKey } },
    null,
    2,
  )}\n`,
)

process.stderr.write(
  `Added master key version ${nextVersion}. Version(s) ${Object.keys(existing.keys).join(', ')} ` +
    `are retained and MUST stay in place until every household DEK has been re-wrapped.\n`,
)
