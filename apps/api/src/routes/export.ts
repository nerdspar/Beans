import { toIsoDate } from '@beans/shared'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import { exportFilename, toCsv } from '../export/csv.js'
import { exportAccounts, exportBalances, exportTransactions } from '../repositories/export.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'

/**
 * Taking your data with you.
 *
 * Beans exists because eight years of history sat in another app behind a one-month-at-a-time PDF
 * export. This is the feature that promises the same thing cannot happen here, so it is complete
 * rather than convenient — and the daily balances are the part that matters, because an investment
 * balance cannot be reconstructed from transactions by whoever receives this file any more than it
 * can be by Beans.
 *
 * **What comes out is plaintext, and that is deliberate.** Everything is encrypted at rest under a
 * key the operator holds; an export is the one moment a household asks for it in the clear. It goes
 * over TLS, to an authenticated session, in response to a click, and is never written to disk on the
 * server. What happens to the file afterwards is the reader's to decide — which is the whole point
 * of being able to leave.
 */

export type ExportRoutesOptions = { auth: Auth; deps: ContextDependencies }

/** The three tables, and the only names the route accepts. */
const EXPORTS = {
  accounts: exportAccounts,
  balances: exportBalances,
  transactions: exportTransactions,
} as const

type ExportName = keyof typeof EXPORTS

function isExportName(value: string): value is ExportName {
  return Object.hasOwn(EXPORTS, value)
}

export const exportRoutes: FastifyPluginAsync<ExportRoutesOptions> = async (fastify, options) => {
  const { auth, deps } = options

  fastify.get<{ Params: { name: string } }>('/api/export/:name', async (request, reply) => {
    const session = await getSession(auth, request.headers)
    if (session === null) return reply.status(401).send({ error: 'Not signed in' })

    const name = request.params.name.replace(/\.csv$/, '')
    if (!isExportName(name)) return reply.status(404).send({ error: 'No such export' })

    try {
      const table = await withHouseholdContext(deps, session.user.id, (context) =>
        EXPORTS[name](context),
      )

      return sendCsv(reply, name, toCsv(table.headers, table.rows))
    } catch (error) {
      if (error instanceof NoHouseholdError) {
        return reply.status(409).send({ error: 'No household' })
      }
      return Promise.reject(error)
    }
  })
}

function sendCsv(reply: FastifyReply, name: string, body: string): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    /*
     * `attachment` with a filename, so a click downloads rather than rendering a wall of text in
     * the tab — and so the file arrives named and dated rather than as the route's last path
     * segment.
     */
    .header(
      'content-disposition',
      `attachment; filename="${exportFilename(name, toIsoDate(new Date()))}"`,
    )
    /*
     * Never cached, anywhere. This is the household's finances in the clear, and a copy sitting in
     * a shared proxy or a browser's disk cache is the one place it should not be.
     */
    .header('cache-control', 'no-store')
    .send(body)
}
