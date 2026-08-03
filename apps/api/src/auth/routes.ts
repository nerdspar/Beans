import type { FastifyPluginAsync } from 'fastify'
import { fromNodeHeaders } from 'better-auth/node'
import type { Auth } from './auth.js'

/**
 * Mounts Better Auth's handler at `/api/auth/*`.
 *
 * Better Auth speaks the Fetch API (`Request` in, `Response` out) and Fastify speaks Node's
 * http objects, so this plugin is the adapter between them. There is no official Fastify
 * integration package; this follows the documented pattern with two corrections noted below.
 */
export const authRoutes: FastifyPluginAsync<{ auth: Auth }> = async (fastify, options) => {
  const { auth } = options

  /**
   * Correction 1: keep the request body raw.
   *
   * The documented pattern does `JSON.stringify(request.body)`, which assumes Fastify already
   * parsed JSON. Better Auth's sign-in and sign-up routes also accept
   * `application/x-www-form-urlencoded` for progressive enhancement, and re-encoding those as
   * JSON mangles them. Passing bytes through untouched avoids the whole class of problem.
   *
   * This is registered inside the plugin, so Fastify's encapsulation confines it to these routes —
   * the rest of the API keeps normal JSON parsing.
   */
  fastify.removeContentTypeParser(['application/json'])
  fastify.addContentTypeParser(
    ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body)
    },
  )

  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)

      const webRequest = new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body === undefined || request.method === 'GET'
          ? {}
          : { body: request.body as Buffer }),
      })

      const response = await auth.handler(webRequest)

      reply.status(response.status)

      /**
       * Correction 2: set cookies via the raw response.
       *
       * `reply.header()` overwrites on repeat keys, so the documented `headers.forEach` loop
       * collapses multiple `Set-Cookie` values into one. Better Auth legitimately sends several —
       * session token plus `dont_remember`, or OAuth state — and losing them presents as
       * "sessions don't stick", which is a miserable thing to debug.
       */
      const setCookies = response.headers.getSetCookie()
      if (setCookies.length > 0) {
        reply.raw.setHeader('set-cookie', setCookies)
      }

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') {
          reply.header(key, value)
        }
      })

      return reply.send(response.body === null ? null : Buffer.from(await response.arrayBuffer()))
    },
  })
}

/**
 * Resolves the current session from a Fastify request, or null.
 *
 * Everything that needs to know who is asking goes through here rather than reading cookies
 * directly.
 */
export async function getSession(auth: Auth, headers: NodeJS.Dict<string | string[]>) {
  return auth.api.getSession({ headers: fromNodeHeaders(headers) })
}
