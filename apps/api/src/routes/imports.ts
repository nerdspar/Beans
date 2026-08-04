import { centsToDecimalString, findPreset, guessMapping } from '@beans/shared'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import { columnSamples, parseCsv } from '../import/csv.js'
import { commitImport, previewImport, reverseImport, stageImport } from '../import/staging.js'
import {
  NoHouseholdError,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'

/**
 * CSV import: inspect, stage, preview, commit, reverse.
 *
 * **Nothing is written to `transactions` until commit.** Staging parses into `import_rows` and the
 * preview is read from there, so a mis-mapped column is discovered while looking at the rows rather
 * than afterwards — and reversal exists for the case where it is discovered later still.
 */

export type ImportRoutesOptions = { auth: Auth; deps: ContextDependencies }

/** Ten megabytes. A decade of transactions from any provider is far below this. */
const MAX_CSV_BYTES = 10 * 1024 * 1024

const inspectBody = z.object({ content: z.string().min(1).max(MAX_CSV_BYTES) })

const stageBody = z.object({
  content: z.string().min(1).max(MAX_CSV_BYTES),
  presetId: z.string().min(1),
  kind: z.enum(['transactions', 'balances']),
  targetAccountId: z.string().uuid(),
  originalFilename: z.string().min(1).max(260),
  mapping: z
    .array(z.object({ columnIndex: z.number().int().min(0), role: z.string().min(1) }))
    .min(1),
  dateFormat: z.enum(['iso', 'month-first', 'day-first', 'ambiguous', 'unrecognized']).optional(),
})

export const importRoutes: FastifyPluginAsync<ImportRoutesOptions> = async (fastify, options) => {
  const { auth, deps } = options

  async function requireUser(request: { headers: unknown }, reply: FastifyReply) {
    const session = await getSession(auth, request.headers as Parameters<typeof getSession>[1])
    if (session === null) {
      await reply.status(401).send({ error: 'Not signed in' })
      return null
    }
    return { id: session.user.id }
  }

  function handleError(error: unknown, reply: FastifyReply): FastifyReply | null {
    if (error instanceof NoHouseholdError) return reply.status(409).send({ error: 'No household' })
    if (error instanceof Error && error.name.startsWith('Import')) {
      return reply.status(400).send({ error: error.message })
    }
    return null
  }

  /**
   * Parses headers and guesses a mapping, writing nothing.
   *
   * Deliberately not part of staging: the user has to see and correct the guess before any row is
   * interpreted, because a wrong amount column is not visible in a total until it is far too late.
   */
  fastify.post('/api/imports/inspect', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = inspectBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'A CSV file is required' })

    try {
      const csv = parseCsv(body.data.content)
      return reply.send({
        headers: csv.headers,
        rowCount: csv.rows.length,
        delimiter: csv.delimiter,
        mapping: guessMapping(csv.headers),
        /*
         * A few values per column, so the mapping can be checked by eye. Headers alone are not
         * enough — "Amount" and "Debit" look equally plausible until you see that one column is all
         * positive, which is exactly the mistake that inverts a year of spending.
         */
        samples: csv.headers.map((_header, index) => columnSamples(csv.rows, index, 3)),
      })
    } catch (error) {
      return handleError(error, reply) ?? reply.status(400).send({ error: 'Could not read that CSV' })
    }
  })

  fastify.post('/api/imports', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = stageBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid import' })

    const preset = findPreset(body.data.presetId)
    if (preset === undefined) return reply.status(400).send({ error: 'Unknown preset' })

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        stageImport(context, {
          csv: parseCsv(body.data.content),
          mapping: body.data.mapping as Parameters<typeof stageImport>[1]['mapping'],
          preset,
          kind: body.data.kind,
          targetAccountId: body.data.targetAccountId,
          originalFilename: body.data.originalFilename,
          ...(body.data.dateFormat === undefined ? {} : { dateFormat: body.data.dateFormat }),
        }),
      )
      return reply.status(201).send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.get<{ Params: { id: string } }>('/api/imports/:id/preview', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const preview = await withHouseholdContext(deps, user.id, (context) =>
        previewImport(context, request.params.id),
      )

      /*
       * Amounts become decimal strings here, as everywhere else money crosses this boundary. The
       * repository returns `bigint` cents, which Fastify cannot serialize at all — it throws "do not
       * know how to serialize a BigInt" and the whole preview 500s. A JSON number would serialize
       * and be wrong above 2^53, which is worse.
       */
      return reply.header('cache-control', 'no-store').send({
        totalRows: preview.totalRows,
        failedRows: preview.failedRows,
        rows: preview.rows.map((row) => ({
          rowNumber: row.rowNumber,
          status: row.status,
          error: row.statusReason,
          date: row.parsed?.date ?? null,
          description: row.parsed?.description ?? null,
          amount: row.parsed === null ? null : centsToDecimalString(row.parsed.amountCents),
        })),
      })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post<{ Params: { id: string } }>('/api/imports/:id/commit', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        commitImport(context, request.params.id),
      )
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  /** The way back from a bad mapping discovered after committing. */
  fastify.post<{ Params: { id: string } }>('/api/imports/:id/reverse', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        reverseImport(context, request.params.id),
      )
      return reply.send(result)
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })
}
