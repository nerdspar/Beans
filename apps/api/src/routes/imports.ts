import { centsToDecimalString, findPreset, guessMapping } from '@beans/shared'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/auth.js'
import { getSession } from '../auth/routes.js'
import { columnSamples, distinctColumnValues, parseCsv } from '../import/csv.js'
import { readProgress } from '../import/progress.js'
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

/**
 * Ten megabytes. A decade of transactions from any provider is far below this.
 *
 * Exported because the server's `bodyLimit` is derived from it. Fastify's 1 MiB default used to
 * reject a real export before this route ever ran, with a bare "Payload Too Large" and no hint that
 * a limit ten times larger was sitting here — two limits disagreeing about which one was real.
 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

const contentField = z
  .string()
  .min(1, 'A CSV file is required')
  // Distinguished from "missing", because "too large" tells the user to split the file and
  // "required" tells them to pick one — and being sent to do the wrong thing wastes real time.
  .max(MAX_IMPORT_BYTES, 'That file is larger than 10 MB. Split it and import the parts separately.')

const inspectBody = z.object({ content: contentField })

const stageBody = z.object({
  content: contentField,
  presetId: z.string().min(1),
  kind: z.enum(['transactions', 'balances']),
  /*
   * One of these is required, and `accountMap` wins when the file names accounts. Both are optional
   * individually because a single-account export and a whole-portfolio export are both normal.
   */
  targetAccountId: z.string().uuid().optional(),
  skippedAccounts: z.array(z.string()).max(500).optional(),
  accountMap: z
    .array(z.object({ value: z.string().min(1), accountId: z.string().uuid() }))
    .max(200)
    .optional(),
  originalFilename: z.string().min(1).max(260),
  mapping: z
    .array(z.object({ columnIndex: z.number().int().min(0), role: z.string().min(1) }))
    .min(1),
  dateFormat: z.enum(['iso', 'month-first', 'day-first', 'ambiguous', 'unrecognized']).optional(),
})

/** The specific complaint, so an oversized file does not read as a missing one. */
function firstMessage(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback
}

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
  /**
   * Recent imports, so an undo outlives the screen that offered it.
   *
   * Committing landed on a page with a reverse button, and that page was the only route to it —
   * navigate away to check whether the numbers look right, which is exactly what somebody does
   * next, and the way back was gone. Returning to Import started a new one.
   *
   * Reversibility already had a lifetime in the data (`reversible_until`); it simply had no
   * surface. Nothing here is new state.
   */
  fastify.get('/api/imports', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const imports = await withHouseholdContext(deps, user.id, async (context) => {
        const rows = await context.client.query<{
          id: string
          original_filename: string
          status: string
          row_count: number
          committed_row_count: number | null
          created_at: Date
          committed_at: Date | null
          reversible_until: Date | null
        }>(
          `select id, original_filename, status, row_count, committed_row_count,
                  created_at, committed_at, reversible_until
             from imports
            order by created_at desc
            limit 20`,
        )

        return rows.rows.map((row) => ({
          id: row.id,
          originalFilename: row.original_filename,
          status: row.status,
          rowCount: row.row_count,
          committedRowCount: row.committed_row_count,
          createdAt: row.created_at.toISOString(),
          committedAt: row.committed_at?.toISOString() ?? null,
          reversibleUntil: row.reversible_until?.toISOString() ?? null,
        }))
      })

      return reply.header('cache-control', 'no-store').send({ imports })
    } catch (error) {
      return handleError(error, reply) ?? Promise.reject(error)
    }
  })

  fastify.post('/api/imports/inspect', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = inspectBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: firstMessage(body.error, 'A CSV file is required') })
    }

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
        /*
         * The distinct values per column, where a column has few enough to be categorical.
         *
         * Returned for every column rather than just the guessed account column, so changing which
         * column means "account" on the mapping screen does not require re-uploading the file — the
         * client already holds what it needs.
         */
        distinct: csv.headers.map((_header, index) => distinctColumnValues(csv.rows, index)),
      })
    } catch (error) {
      return handleError(error, reply) ?? reply.status(400).send({ error: 'Could not read that CSV' })
    }
  })

  fastify.post('/api/imports', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    const body = stageBody.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: firstMessage(body.error, 'Invalid import') })
    }

    const preset = findPreset(body.data.presetId)
    if (preset === undefined) return reply.status(400).send({ error: 'Unknown preset' })

    const namesAccounts = body.data.mapping.some((column) => column.role === 'account')
    const hasAccountMap =
      (body.data.accountMap ?? []).length > 0 || (body.data.skippedAccounts ?? []).length > 0

    // Refused rather than defaulted: picking an account for a file that names its own would put
    // every row in one place, which is precisely the mistake this check exists to prevent.
    if (!hasAccountMap && body.data.targetAccountId === undefined) {
      return reply.status(400).send({
        error: namesAccounts
          ? 'Map the accounts in this file to your accounts before importing.'
          : 'Choose which account these rows belong to.',
      })
    }

    try {
      const result = await withHouseholdContext(deps, user.id, (context) =>
        stageImport(context, {
          csv: parseCsv(body.data.content),
          mapping: body.data.mapping as Parameters<typeof stageImport>[1]['mapping'],
          preset,
          kind: body.data.kind,
          targetAccountId: body.data.targetAccountId,
          accountMap: body.data.accountMap,
          skippedAccounts: body.data.skippedAccounts,
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
        skippedRows: preview.skippedRows,
        reasons: preview.reasons,
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

  /**
   * How far the running import has got.
   *
   * Polled while a stage or commit is in flight. Deliberately cheap and deliberately not a database
   * read: those rows are inside an open transaction and invisible until it lands, so counting them
   * would report zero for the whole run and then the total — the one shape indistinguishable from a
   * hang. See `import/progress.ts`.
   */
  fastify.get('/api/imports/progress', async (request, reply) => {
    const user = await requireUser(request, reply)
    if (user === null) return

    try {
      const progress = await withHouseholdContext(deps, user.id, async (context) =>
        readProgress(context.householdId),
      )
      return reply.header('cache-control', 'no-store').send({ progress })
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
