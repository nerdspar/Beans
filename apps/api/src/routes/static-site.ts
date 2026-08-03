import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'

/**
 * Serves the built frontend from the same origin as the API.
 *
 * **One origin is the whole point.** The session cookie, the working-set endpoint and the app are
 * all same-origin in production, which is why `EXTRA_TRUSTED_ORIGINS` is empty there and why nothing
 * needs CORS. Development is the exception, not this.
 *
 * Registered last so it cannot shadow an API route: `/api/*` and `/health` are matched by their own
 * handlers first, and only unmatched paths reach the SPA fallback below.
 */

/**
 * `apps/web/dist`, relative to this module.
 *
 * Resolves identically in both layouts by accident of symmetry — `apps/api/src/routes/` in
 * development and `apps/api/dist/` in the container are both two levels under `apps/`. The
 * existence check below is what makes a wrong answer harmless rather than a boot failure.
 */
function resolveWebRoot(): string {
  const fromDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(fromDist)) return fromDist

  return fileURLToPath(new URL('../../../web/dist', import.meta.url))
}

/**
 * Sends `index.html` without the plugin's caching.
 *
 * `cacheControl: false` is load-bearing. `sendFile` applies the options the plugin was registered
 * with, so a header set on the reply beforehand is overwritten by the one-year immutable value meant
 * for fingerprinted assets — and `index.html` is the one file whose name never changes, so caching it
 * pins every client to the build it first loaded and no deploy ever reaches them.
 */
function sendIndex(reply: FastifyReply, root: string): FastifyReply {
  return reply
    .type('text/html')
    .header('cache-control', 'no-cache')
    .sendFile('index.html', root, { cacheControl: false })
}

export const staticSiteRoutes: FastifyPluginAsync = async (fastify) => {
  const root = resolveWebRoot()

  if (!existsSync(root)) {
    /*
     * Normal in development, where Vite serves the frontend on its own port and nothing has been
     * built. Logged rather than thrown, because an API running without a frontend is a legitimate
     * state — but logged loudly, because in a container it means the image was built wrong and the
     * symptom is a 404 on every page while `/health` reports fine.
     */
    fastify.log.warn({ root }, 'no built frontend found; serving API only')
    return
  }

  await fastify.register(fastifyStatic, {
    root,
    /*
     * Long-lived caching is safe because Vite fingerprints every asset filename. `index.html` is the
     * exception and is handled below — it is the one file whose name never changes, so caching it
     * would pin clients to an old build after a deploy.
     */
    maxAge: '1y',
    immutable: true,
    index: false,
  })

  /*
   * The root, explicitly.
   *
   * `index: false` above is deliberate — letting the static plugin serve `index.html` would give it
   * the one-year immutable header meant for fingerprinted assets, pinning every client to the build
   * they first loaded. But with it off, a request for `/` resolves to a directory and the plugin
   * answers 403 rather than declining, so it never reaches the fallback. An exact route outranks the
   * plugin's wildcard and sends the same response the fallback would.
   */
  fastify.get('/', async (_request, reply) => sendIndex(reply, root))

  /**
   * The SPA fallback.
   *
   * Every unmatched path returns `index.html` so a deep link — `/accounts/<id>`, or a refresh on
   * `/connections` — loads the app rather than 404ing. Registered as `setNotFoundHandler` rather
   * than a wildcard route so it runs only after every real route has declined.
   */
  fastify.setNotFoundHandler(async (request, reply) => {
    /*
     * An unknown API path is a genuine 404 and must say so. Falling back to HTML there would answer
     * a fetch with a page, and the client would fail on a JSON parse instead of on a status code —
     * which is a far worse thing to debug.
     */
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) {
      return reply.status(404).send({ error: 'Not found' })
    }

    return sendIndex(reply, root)
  })
}
