import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { findPreset, guessMapping, type IsoDate } from '@beans/shared'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from '../repositories/household-context.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import { parseCsv } from './csv.js'
import { confirmSeamMatches, findSeamCandidates, setImportCutover } from './seam.js'
import { commitImport, previewImport, reverseImport, stageImport } from './staging.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')
const USER = 'import-user-fixed-id'
const NOW = new Date('2026-08-03T12:00:00.000Z')

const EMPOWER_CSV = `Date,Description,Category,Amount,Account
08/01/2026,TRADER JOE'S #452,Groceries,-52.40,Checking
07/28/2026,PAYCHECK ACME CORP,Paychecks,3200.00,Checking
07/15/2026,AMAZON MARKETPLACE,Shopping,-129.99,Checking
`

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('csv import', () => {
  let pool: Pool
  let deps: ContextDependencies

  async function makeAccount(context: HouseholdContext): Promise<string> {
    const result = await context.client.query<{ id: string }>(
      `insert into accounts (household_id, type, currency, current_balance, balance_as_of,
                             coverage_start_date, confirmed_at)
       values ($1,'depository','USD',$2,$3,'2026-07-01',$3) returning id`,
      [context.householdId, context.cipher.encryptMoney(100_000n), NOW],
    )
    return result.rows[0]!.id
  }

  /**
   * `dateFormat` is stated explicitly because small fixtures are frequently ambiguous — a file
   * whose days all happen to be 12 or lower genuinely cannot be read either way, and the stager
   * refuses rather than guessing. Real exports spanning months disambiguate themselves.
   */
  async function stage(
    context: HouseholdContext,
    accountId: string,
    csvText = EMPOWER_CSV,
    dateFormat: 'month-first' | 'day-first' | undefined = undefined,
  ): Promise<string> {
    const csv = parseCsv(csvText)
    const result = await stageImport(context, {
      csv,
      mapping: guessMapping(csv.headers),
      preset: findPreset('empower')!,
      kind: 'transactions',
      targetAccountId: accountId,
      originalFilename: 'empower-export.csv',
      ...(dateFormat === undefined ? {} : { dateFormat }),
    })
    return result.importId
  }

  const readTransactions = async (context: HouseholdContext) => {
    const rows = await context.client.query<{
      posted_date: IsoDate
      amount: Buffer
      description: Buffer
      source: string
    }>('select posted_date, amount, description, source from transactions order by posted_date')
    return rows.rows.map((row) => ({
      date: row.posted_date,
      amount: context.cipher.decryptMoney(row.amount),
      description: context.cipher.decryptText(row.description),
      source: row.source,
    }))
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({
        currentVersion: 1,
        keys: { 1: MASTER_KEY },
      }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
    await resetAll(pool)
    await pool.query(
      'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
      [USER, 'Test User', 'import@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER])
    await createHousehold(deps, USER, 'The Goldbergs')
  })

  /**
   * A whole-portfolio export, shaped after the real thing: an account named on every row, dollar
   * signs, and quoted thousands separators.
   */
  const MULTI_ACCOUNT_CSV = `Date,Description,Category,Institution,Account Name,Amount,Tags
2026-07-21,Malden Catholic,Education,Bank of America,Rental Checking,-$122.17,
2026-07-20,Amazon,General Merchandise,Chase,Amazon Card,-$27.60,
2026-07-20,Transfer,Transfers,Wealthfront,Joint Cash Account,"-$1,000.00",
2026-07-19,Whole Foods Market,Groceries,Chase,Amazon Card,-$77.94,
`

  /**
   * Routing a file that names its own accounts.
   *
   * Staging used to write one `targetAccountId` onto every row, so an export covering a whole
   * portfolio imported cleanly with all of it filed against a single account. Nothing failed and
   * nothing warned; the balances were simply wrong afterwards.
   */
  describe('multi-account routing', () => {
    async function stageMulti(
      context: HouseholdContext,
      accountMap: ReadonlyArray<{ value: string; accountId: string }>,
    ): Promise<string> {
      const csv = parseCsv(MULTI_ACCOUNT_CSV)
      const result = await stageImport(context, {
        csv,
        mapping: guessMapping(csv.headers),
        preset: findPreset('empower')!,
        kind: 'transactions',
        accountMap,
        originalFilename: 'empower-all-accounts.csv',
      })
      return result.importId
    }

    const stagedRows = async (context: HouseholdContext, importId: string) => {
      const rows = await context.client.query<{
        row_number: number
        status: string
        status_reason: string | null
        target_account_id: string | null
      }>(
        `select row_number, status, status_reason, target_account_id
           from import_rows where import_id = $1 order by row_number`,
        [importId],
      )
      return rows.rows
    }

    it('files each row against the account its own row names', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)
        const checking = await makeAccount(ctx)
        const cash = await makeAccount(ctx)

        const importId = await stageMulti(ctx, [
          { value: 'Amazon Card', accountId: card },
          { value: 'Rental Checking', accountId: checking },
          { value: 'Joint Cash Account', accountId: cash },
        ])

        return { rows: await stagedRows(ctx, importId), card, checking, cash }
      })

      expect(result.rows.map((row) => row.target_account_id)).toEqual([
        result.checking,
        result.card,
        result.cash,
        result.card,
      ])
      expect(result.rows.every((row) => row.status === 'pending')).toBe(true)
    })

    /**
     * The rule that makes the routing trustworthy. Sending unmatched rows to a default account is
     * exactly the silent misfiling this replaces, so they fail visibly and name what was missing.
     */
    it('fails an unmapped row rather than filing it somewhere plausible', async () => {
      const rows = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)
        const importId = await stageMulti(ctx, [{ value: 'Amazon Card', accountId: card }])
        return await stagedRows(ctx, importId)
      })

      const failed = rows.filter((row) => row.status === 'failed')
      expect(failed).toHaveLength(2)
      expect(failed.every((row) => row.target_account_id === null)).toBe(true)
      // Named, so the preview says which account is missing instead of just a count.
      expect(failed[0]?.status_reason).toContain('Rental Checking')
      expect(failed[1]?.status_reason).toContain('Joint Cash Account')
    })

    /**
     * The batch boundary, which every small fixture above steps straight over.
     *
     * Rows are inserted in batches of {@link INSERT_BATCH}, and the statement is built by numbering
     * placeholders `$1..$n` across the whole batch. An off-by-one in that arithmetic would not
     * fail — it would shift every value one position, filing rows against the wrong account with a
     * `row_number` from its neighbour, and no small fixture would ever notice because a single
     * batch flushes only at the end.
     *
     * So this stages more rows than a batch holds and asserts the boring things: all of them
     * arrived, numbered 1..n in order, each against the account its own row named.
     */
    it('keeps every row, in order, across an insert batch boundary', async () => {
      const ROWS = 1201

      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)
        const checking = await makeAccount(ctx)

        // Alternating accounts, so a shifted value lands on the wrong one rather than by luck.
        const lines = Array.from({ length: ROWS }, (_, index) => {
          const account = index % 2 === 0 ? 'Amazon Card' : 'Rental Checking'
          return `2026-07-21,Row ${index},General Merchandise,Chase,${account},-$1.00,`
        })

        const csv = parseCsv(
          `Date,Description,Category,Institution,Account Name,Amount,Tags\n${lines.join('\n')}\n`,
        )

        const staged = await stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          accountMap: [
            { value: 'Amazon Card', accountId: card },
            { value: 'Rental Checking', accountId: checking },
          ],
          originalFilename: 'big.csv',
        })

        return { staged, rows: await stagedRows(ctx, staged.importId), card, checking }
      })

      expect(result.staged.rowCount).toBe(ROWS)
      expect(result.staged.parsedCount).toBe(ROWS)
      expect(result.rows).toHaveLength(ROWS)

      // Contiguous and in order: a batch written out of sequence would show up here.
      expect(result.rows.map((row) => row.row_number)).toEqual(
        Array.from({ length: ROWS }, (_, index) => index + 1),
      )

      // Every row against the account it named, including across every flush.
      const misfiled = result.rows.filter(
        (row, index) =>
          row.target_account_id !== (index % 2 === 0 ? result.card : result.checking),
      )
      expect(misfiled).toHaveLength(0)
      expect(result.rows.every((row) => row.status === 'pending')).toBe(true)
    })

    /**
     * A partial re-import: pick up one account, deliberately skip the rest.
     *
     * A skip and an oversight produce identical rows, so without an explicit answer the server
     * cannot tell them apart — and reporting forty deliberate decisions as forty errors buries the
     * one line that might genuinely need acting on.
     */
    it('records a deliberate skip as a skip, not a failure', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)

        const csv = parseCsv(MULTI_ACCOUNT_CSV)
        const staged = await stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          accountMap: [{ value: 'Amazon Card', accountId: card }],
          skippedAccounts: ['Rental Checking', 'Joint Cash Account'],
          originalFilename: 'partial.csv',
        })

        return { staged, rows: await stagedRows(ctx, staged.importId) }
      })

      // Two Amazon Card rows import; the other two were skipped on purpose.
      expect(result.staged.parsedCount).toBe(2)
      expect(result.staged.skippedCount).toBe(2)
      expect(result.staged.failedCount).toBe(0)

      expect(result.rows.filter((row) => row.status === 'skipped')).toHaveLength(2)
      expect(result.rows.filter((row) => row.status === 'failed')).toHaveLength(0)
    })

    /** An account nobody answered for is still a failure — that is the distinction. */
    it('still fails an account that was neither mapped nor skipped', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)

        const csv = parseCsv(MULTI_ACCOUNT_CSV)
        const staged = await stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          accountMap: [{ value: 'Amazon Card', accountId: card }],
          skippedAccounts: ['Rental Checking'],
          originalFilename: 'partial.csv',
        })

        return staged
      })

      expect(result.skippedCount).toBe(1)
      expect(result.failedCount).toBe(1)
      // And split by cause, which is what tells the reader which fix applies.
      expect(result.unroutedCount).toBe(1)
      expect(result.unparsedCount).toBe(0)
    })

    /** Skipped rows must not be committed by the very next step. */
    it('commits nothing for a skipped account', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)

        const csv = parseCsv(MULTI_ACCOUNT_CSV)
        const staged = await stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          accountMap: [{ value: 'Amazon Card', accountId: card }],
          skippedAccounts: ['Rental Checking', 'Joint Cash Account'],
          originalFilename: 'partial.csv',
        })

        return commitImport(ctx, staged.importId, new Date('2026-08-05T12:00:00Z'))
      })

      expect(result.committed).toBe(2)
    })

    /**
     * Undo, then redo.
     *
     * Reversing deletes the transactions and returns every row to `pending`, so the staged data
     * survives in full — somebody who undid an import to see what changed should not have to
     * re-upload and re-map the file to put it back.
     */
    it('can commit a reversed import again', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)
        const now = new Date('2026-08-05T12:00:00Z')

        const csv = parseCsv(MULTI_ACCOUNT_CSV)
        const staged = await stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          accountMap: [{ value: 'Amazon Card', accountId: card }],
          skippedAccounts: ['Rental Checking', 'Joint Cash Account'],
          originalFilename: 'redo.csv',
        })

        const first = await commitImport(ctx, staged.importId, now)
        const reversed = await reverseImport(ctx, staged.importId, now)
        const second = await commitImport(ctx, staged.importId, now)

        const live = await ctx.client.query<{ count: string }>(
          'select count(*)::text as count from transactions where import_id = $1',
          [staged.importId],
        )

        return { first, reversed, second, live: Number(live.rows[0]?.count ?? 0) }
      })

      expect(result.first.committed).toBe(2)
      expect(result.reversed.reversed).toBe(2)
      expect(result.second.committed).toBe(2)
      // Re-applied, not doubled — the rows came back rather than arriving twice.
      expect(result.live).toBe(2)
    })

    /** Committing twice without reversing is still refused: that is the doubling this guards. */
    it('refuses to commit an import that is already committed', async () => {
      await expect(
        withHouseholdContext(deps, USER, async (ctx) => {
          const card = await makeAccount(ctx)
          const now = new Date('2026-08-05T12:00:00Z')

          const csv = parseCsv(MULTI_ACCOUNT_CSV)
          const staged = await stageImport(ctx, {
            csv,
            mapping: guessMapping(csv.headers),
            preset: findPreset('empower')!,
            kind: 'transactions',
            accountMap: [{ value: 'Amazon Card', accountId: card }],
            originalFilename: 'twice.csv',
          })

          await commitImport(ctx, staged.importId, now)
          return commitImport(ctx, staged.importId, now)
        }),
      ).rejects.toThrow(/committed/)
    })

    it('matches account names case-insensitively', async () => {
      const rows = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)
        const importId = await stageMulti(ctx, [{ value: 'aMaZoN cArD', accountId: card }])
        return await stagedRows(ctx, importId)
      })

      expect(rows.filter((row) => row.status === 'pending')).toHaveLength(2)
    })

    it('commits each row to its own account', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const card = await makeAccount(ctx)
        const checking = await makeAccount(ctx)
        const cash = await makeAccount(ctx)

        const importId = await stageMulti(ctx, [
          { value: 'Amazon Card', accountId: card },
          { value: 'Rental Checking', accountId: checking },
          { value: 'Joint Cash Account', accountId: cash },
        ])
        const committed = await commitImport(ctx, importId, NOW)

        const perAccount = await ctx.client.query<{ account_id: string; count: string }>(
          'select account_id, count(*)::text as count from transactions group by account_id',
        )

        return { committed, perAccount: perAccount.rows, card, checking, cash }
      })

      expect(result.committed.committed).toBe(4)
      const byAccount = new Map(result.perAccount.map((row) => [row.account_id, row.count]))
      expect(byAccount.get(result.card)).toBe('2')
      expect(byAccount.get(result.checking)).toBe('1')
      expect(byAccount.get(result.cash)).toBe('1')
    })

    /** Quoted thousands separators are not decoration this can afford to lose. */
    it('parses an amount written as "-$1,000.00"', async () => {
      const amounts = await withHouseholdContext(deps, USER, async (ctx) => {
        const cash = await makeAccount(ctx)
        const importId = await stageMulti(ctx, [{ value: 'Joint Cash Account', accountId: cash }])
        await commitImport(ctx, importId, NOW)

        const rows = await ctx.client.query<{ amount: Buffer }>(
          'select amount from transactions where account_id = $1',
          [cash],
        )
        return rows.rows.map((row) => ctx.cipher.decryptMoney(row.amount))
      })

      expect(amounts).toEqual([-100_000n])
    })

    /**
     * The single-destination path is unchanged. An account column in the file is not enough on its
     * own to trigger routing — a map has to be supplied — so a file exported from one account's page
     * still imports to the account the user picked.
     */
    it('still sends every row to one account when no map is supplied', async () => {
      const rows = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        const importId = await stage(ctx, accountId)
        return await stagedRows(ctx, importId)
      })

      expect(rows).toHaveLength(3)
      expect(new Set(rows.map((row) => row.target_account_id)).size).toBe(1)
    })
  })

  describe('csv parsing', () => {
    it('detects the delimiter and header row', () => {
      const csv = parseCsv(EMPOWER_CSV)
      expect(csv.delimiter).toBe(',')
      expect(csv.headerRowIndex).toBe(0)
      expect(csv.headers).toEqual(['Date', 'Description', 'Category', 'Amount', 'Account'])
      expect(csv.rows).toHaveLength(3)
    })

    /**
     * Real exports open with a title or a date range. Taking row 0 on faith imports the preamble as
     * a transaction and maps every column wrong.
     */
    it('skips preamble rows before the header', () => {
      const csv = parseCsv(
        `Personal Capital Transactions Export
Date Range: 01/01/2019 - 08/03/2026

Date,Description,Amount
08/01/2026,COFFEE,-4.50
`,
      )

      expect(csv.headers).toEqual(['Date', 'Description', 'Amount'])
      expect(csv.rows).toHaveLength(1)
    })

    it('handles quoted fields containing the delimiter', () => {
      const csv = parseCsv(`Date,Description,Amount\n08/01/2026,"SMITH, JOHN & CO",-10.00\n`)
      expect(csv.rows[0]).toEqual(['08/01/2026', 'SMITH, JOHN & CO', '-10.00'])
    })

    it('handles tab-separated files', () => {
      const csv = parseCsv('Date\tDescription\tAmount\n08/01/2026\tCOFFEE\t-4.50\n')
      expect(csv.delimiter).toBe('\t')
      expect(csv.headers).toEqual(['Date', 'Description', 'Amount'])
    })

    it('strips a UTF-8 BOM', () => {
      const csv = parseCsv(`﻿Date,Description,Amount\n08/01/2026,COFFEE,-4.50\n`)
      // Without stripping, the first header would be "﻿Date" and never match a hint.
      expect(csv.headers[0]).toBe('Date')
    })

    it('rejects an empty file rather than importing nothing', () => {
      expect(() => parseCsv('   ')).toThrow(/empty/)
    })
  })

  describe('staging', () => {
    it('parses every row without touching transactions', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        const csv = parseCsv(EMPOWER_CSV)

        const staged = await stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          targetAccountId: accountId,
          originalFilename: 'empower-export.csv',
        })

        const transactions = await ctx.client.query('select 1 from transactions')
        return { staged, transactionCount: transactions.rowCount }
      })

      expect(result.staged.parsedCount).toBe(3)
      expect(result.staged.failedCount).toBe(0)
      expect(result.staged.dateFormat).toBe('month-first')
      // Nothing real has been written yet.
      expect(result.transactionCount).toBe(0)
    })

    /**
     * A silent drop in a file of thirty thousand rows is invisible; the count not matching is the
     * only clue anyone would get.
     */
    it('stages an unparseable row as failed rather than dropping it', async () => {
      const preview = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        const importId = await stage(
          ctx,
          accountId,
          `Date,Description,Amount
08/01/2026,GOOD ROW,-52.40
not-a-date,BAD ROW,-10.00
08/02/2026,NO AMOUNT,
`,
          'month-first',
        )
        return previewImport(ctx, importId)
      })

      expect(preview.totalRows).toBe(3)
      expect(preview.failedRows).toBe(2)
      expect(preview.rows.filter((r) => r.status === 'failed').map((r) => r.statusReason)).toEqual([
        expect.stringMatching(/date/i),
        expect.stringMatching(/amount/i),
      ])
    })

    it('refuses to stage when the date format is ambiguous', async () => {
      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        // Every day is 12 or lower, so month-first and day-first are indistinguishable.
        const csv = parseCsv(`Date,Description,Amount
03/04/2026,COFFEE,-4.50
05/06/2026,LUNCH,-12.00
`)
        return stageImport(ctx, {
          csv,
          mapping: guessMapping(csv.headers),
          preset: findPreset('empower')!,
          kind: 'transactions',
          targetAccountId: accountId,
          originalFilename: 'ambiguous.csv',
        })
      })

      // Guessing wrong shifts every date by up to eleven months while importing perfectly cleanly.
      expect(result.importId).toBe('')
      expect(result.problems[0]?.message).toMatch(/month-first or day-first/)
    })

    it('encrypts the staged payloads', async () => {
      const ciphertext = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await stage(ctx, accountId)
        const rows = await ctx.client.query<{ raw: Buffer }>(
          'select raw from import_rows order by row_number limit 1',
        )
        return rows.rows[0]?.raw.toString('utf8')
      })

      expect(ciphertext).not.toContain('TRADER')
    })
  })

  describe('commit and reverse', () => {
    it('creates transactions marked as imported', async () => {
      const transactions = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        const importId = await stage(ctx, accountId)

        const result = await commitImport(ctx, importId, NOW)
        expect(result).toEqual({ committed: 3, skipped: 0 })

        return readTransactions(ctx)
      })

      expect(transactions).toEqual([
        {
          date: '2026-07-15',
          amount: -12999n,
          description: 'AMAZON MARKETPLACE',
          source: 'imported',
        },
        {
          date: '2026-07-28',
          amount: 320000n,
          description: 'PAYCHECK ACME CORP',
          source: 'imported',
        },
        {
          date: '2026-08-01',
          amount: -5240n,
          description: "TRADER JOE'S #452",
          source: 'imported',
        },
      ])
    })

    it('refuses to commit twice', async () => {
      await expect(
        withHouseholdContext(deps, USER, async (ctx) => {
          const accountId = await makeAccount(ctx)
          const importId = await stage(ctx, accountId)
          await commitImport(ctx, importId, NOW)
          return commitImport(ctx, importId, NOW)
        }),
      ).rejects.toThrow(/cannot be committed again/)
    })

    it('reverses as a unit, deleting exactly what it created', async () => {
      const after = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)

        // A pre-existing synced transaction that must survive the reversal.
        await ctx.client.query(
          `insert into transactions (household_id, account_id, posted_date, amount, description, source)
           values ($1,$2,'2026-07-20',$3,$4,'synced')`,
          [
            ctx.householdId,
            accountId,
            ctx.cipher.encryptMoney(-1000n),
            ctx.cipher.encryptText('SYNCED ROW'),
          ],
        )

        const importId = await stage(ctx, accountId)
        await commitImport(ctx, importId, NOW)
        const result = await reverseImport(ctx, importId, NOW)
        expect(result.reversed).toBe(3)

        return readTransactions(ctx)
      })

      expect(after).toHaveLength(1)
      expect(after[0]?.source).toBe('synced')
    })

    it('writes tombstones so clients learn the rows are gone', async () => {
      const tombstones = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        const importId = await stage(ctx, accountId)
        await commitImport(ctx, importId, NOW)
        await reverseImport(ctx, importId, NOW)

        const rows = await ctx.client.query<{ entity_type: string }>(
          'select entity_type from deletions',
        )
        return rows.rows
      })

      // Without these, every client keeps the reversed transactions forever with no way to learn.
      expect(tombstones).toHaveLength(3)
      expect(tombstones.every((t) => t.entity_type === 'transaction')).toBe(true)
    })

    it('refuses to reverse after the window closes', async () => {
      await expect(
        withHouseholdContext(deps, USER, async (ctx) => {
          const accountId = await makeAccount(ctx)
          const importId = await stage(ctx, accountId)
          await commitImport(ctx, importId, NOW)
          return reverseImport(ctx, importId, new Date('2026-10-03T12:00:00.000Z'))
        }),
      ).rejects.toThrow(/reversal window/)
    })
  })

  /**
   * An import proposes transfers, as a sync does.
   *
   * It never used to. A file of a household's own history is full of transfers — every card
   * payment, every move to savings — and none of them were proposed until somebody pressed the
   * button on the cash flow screen, which nobody presses to check for a problem they cannot see.
   * Both totals stayed inflated by the same amount, with net looking untouched and nothing saying so.
   */
  it('proposes a transfer among the rows it just committed', async () => {
    const proposals = await withHouseholdContext(deps, USER, async (ctx) => {
      const checking = await makeAccount(ctx)
      const card = await makeAccount(ctx)

      // The same amount leaving one account and arriving in the other, two days apart — a card
      // payment, which is the commonest transfer in anybody's file.
      const csv = parseCsv(
        `Date,Description,Category,Amount,Account
2026-08-01,CHASE CREDIT CRD AUTOPAY,Transfers,-500.00,Checking
2026-08-03,PAYMENT THANK YOU,Transfers,500.00,Card
`,
      )

      const staged = await stageImport(ctx, {
        csv,
        mapping: guessMapping(csv.headers),
        preset: findPreset('empower')!,
        kind: 'transactions',
        accountMap: [
          { value: 'Checking', accountId: checking },
          { value: 'Card', accountId: card },
        ],
        originalFilename: 'transfers.csv',
        dateFormat: 'iso',
      })

      await commitImport(ctx, staged.importId, NOW)

      const rows = await ctx.client.query<{ status: string }>('select status from transfer_matches')
      return rows.rows
    })

    expect(proposals).toHaveLength(1)
    // Proposed, never confirmed. A proposal moves no total; only a person excludes anything.
    expect(proposals[0]?.status).toBe('proposed')
  })

  describe('the seam', () => {
    /** Seeds a synced transaction that duplicates an imported one under a different description. */
    async function seedSynced(
      context: HouseholdContext,
      accountId: string,
      date: IsoDate,
      amountCents: bigint,
      description: string,
    ): Promise<void> {
      await context.client.query(
        `insert into transactions (household_id, account_id, posted_date, amount, description, source)
         values ($1,$2,$3,$4,$5,'synced')`,
        [
          context.householdId,
          accountId,
          date,
          context.cipher.encryptMoney(amountCents),
          context.cipher.encryptText(description),
        ],
      )
    }

    it('proposes a match across differing descriptions and a few days', async () => {
      const candidates = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        // Same amount, two days later, entirely different text — matching on description is hopeless.
        await seedSynced(ctx, accountId, '2026-08-03', -5240n, 'Trader Joes')

        const importId = await stage(ctx, accountId)
        return findSeamCandidates(ctx, importId)
      })

      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({
        importedDescription: "TRADER JOE'S #452",
        syncedDescription: 'Trader Joes',
        dayDistance: 2,
      })
    })

    /**
     * Loosening amount matching is exactly how mortgage payments would start matching: a payment
     * leaves checking as one amount and reduces the mortgage by only the principal portion.
     */
    it('does not match a near-miss amount', async () => {
      const candidates = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await seedSynced(ctx, accountId, '2026-08-01', -5241n, 'Trader Joes')

        const importId = await stage(ctx, accountId)
        return findSeamCandidates(ctx, importId)
      })

      expect(candidates).toEqual([])
    })

    it('does not match beyond the date window', async () => {
      const candidates = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        // Same amount, three weeks apart: two real purchases, not a duplicate.
        await seedSynced(ctx, accountId, '2026-08-22', -5240n, 'Trader Joes')

        const importId = await stage(ctx, accountId)
        return findSeamCandidates(ctx, importId)
      })

      expect(candidates).toEqual([])
    })

    it('claims each synced transaction at most once', async () => {
      const candidates = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await seedSynced(ctx, accountId, '2026-08-01', -5240n, 'Trader Joes')

        // Two imported rows with the same amount, both near the single synced transaction.
        const importId = await stage(
          ctx,
          accountId,
          `Date,Description,Amount
08/01/2026,TRADER JOE'S,-52.40
08/02/2026,TRADER JOE'S AGAIN,-52.40
`,
          'month-first',
        )
        return findSeamCandidates(ctx, importId)
      })

      // Otherwise both would be skipped at commit and one real transaction would vanish.
      expect(candidates).toHaveLength(1)
    })

    it('skips a confirmed duplicate at commit, so the seam does not double count', async () => {
      const transactions = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await seedSynced(ctx, accountId, '2026-08-01', -5240n, 'Trader Joes')

        const importId = await stage(ctx, accountId)
        const candidates = await findSeamCandidates(ctx, importId)

        await confirmSeamMatches(
          ctx,
          candidates.map((candidate) => ({
            importRowId: candidate.importRowId,
            transactionId: candidate.transactionId,
            confirmed: true,
          })),
        )

        const result = await commitImport(ctx, importId, NOW)
        expect(result).toEqual({ committed: 2, skipped: 1 })

        return readTransactions(ctx)
      })

      // Three imported rows, one a confirmed duplicate: two imported plus the original synced row.
      expect(transactions).toHaveLength(3)
      expect(transactions.filter((t) => t.amount === -5240n)).toHaveLength(1)
    })

    it('imports a rejected match normally', async () => {
      const transactions = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await seedSynced(ctx, accountId, '2026-08-01', -5240n, 'Trader Joes')

        const importId = await stage(ctx, accountId)
        const candidates = await findSeamCandidates(ctx, importId)

        // The user says these really are two separate purchases.
        await confirmSeamMatches(
          ctx,
          candidates.map((candidate) => ({
            importRowId: candidate.importRowId,
            transactionId: candidate.transactionId,
            confirmed: false,
          })),
        )

        await commitImport(ctx, importId, NOW)
        return readTransactions(ctx)
      })

      expect(transactions.filter((t) => t.amount === -5240n)).toHaveLength(2)
    })

    it('records the cutover date', async () => {
      const cutover = await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await setImportCutover(ctx, accountId, '2026-08-02')

        const rows = await ctx.client.query<{ import_cutover_date: IsoDate }>(
          'select import_cutover_date from accounts where id = $1',
          [accountId],
        )
        return rows.rows[0]?.import_cutover_date
      })

      expect(cutover).toBe('2026-08-02')
    })
  })
})
