import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'

/**
 * Validates a master key file the way the server does at boot.
 *
 *   pnpm --filter @beans/api dev:check-key <path>
 *
 * Exists because the failure it catches is otherwise only visible as a container that will not
 * start: the file must be JSON of the shape `{ currentVersion, keys }`, not a bare base64 string,
 * and that is easy to get wrong when creating it by hand on a server.
 */
const path = process.argv[2]
if (path === undefined) throw new Error('Usage: dev:check-key <path>')

const provider = await LocalMasterKeyProvider.fromFile(path)
console.log(`Valid. currentVersion present, versions: ${provider.availableKeyVersions.join(', ')}`)
