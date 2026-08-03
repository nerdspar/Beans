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
