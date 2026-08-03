import { cp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Production build for the API.
 *
 * Bundles rather than plain `tsc` for one reason: `@beans/shared` is consumed as **TypeScript
 * source** by both this package and the web app (its `main` points at `src/index.ts`). A `tsc`
 * output would emit `import '@beans/shared'` and Node would find an unbuilt TS package at runtime.
 * Bundling inlines it and the problem disappears, without giving shared a dual src/dist identity
 * that both consumers then have to understand.
 *
 * Everything in `dependencies` stays external. Several are native or have native optional paths —
 * `@node-rs/argon2`, `pg` — and bundling those is how you get a container that builds cleanly and
 * then cannot hash a password.
 */

const root = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true })

await build({
  entryPoints: [`${root}src/index.ts`],
  outfile: `${root}dist/index.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // The workspace package is the one thing that must be inlined; everything else resolves from
  // node_modules at runtime exactly as it does in development.
  external: Object.keys(pkg.dependencies ?? {}).filter((name) => name !== '@beans/shared'),
  logLevel: 'info',
})

/*
 * Migrations are read from disk at runtime, resolved relative to the module that reads them. They
 * are SQL files, so the bundler neither sees nor carries them — without this copy the container
 * starts, finds an empty migrations folder, and reports a healthy boot against an empty schema.
 */
await cp(new URL('./src/db/migrations', import.meta.url), new URL('./dist/migrations', import.meta.url), {
  recursive: true,
})
