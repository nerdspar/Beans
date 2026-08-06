/**
 * Column mapping for CSV import.
 *
 * A **generic mapper**, not an Empower parser. The user uploads a file, we guess which column means
 * what, they correct the guesses, and the corrections are just data. Empower ships as a preset so
 * Monarch, Mint and YNAB are configuration rather than code.
 *
 * Nothing here hardcodes an exact column name as a requirement — the header patterns below are
 * hints for the initial guess, and a file that matches none of them is still fully importable by
 * hand.
 */

/** What a column means. `ignore` is explicit so a user can dismiss a column rather than leave it. */
export const COLUMN_ROLES = [
  'ignore',
  'date',
  'description',
  'amount',
  /** Some exports split direction into separate debit and credit columns instead of signing one. */
  'debit',
  'credit',
  'category',
  'account',
  'payee',
  'memo',
  /** For balance-history exports rather than transaction exports. */
  'balance',
] as const

export type ColumnRole = (typeof COLUMN_ROLES)[number]

export type ColumnMapping = {
  /** Index into the header row. */
  columnIndex: number
  role: ColumnRole
}

export type ImportKind = 'transactions' | 'balances'

export type ImportPreset = {
  id: string
  label: string
  kind: ImportKind
  /**
   * How this export signs amounts.
   *
   * `signed` — one amount column, negative for spending.
   * `debit-credit` — separate columns, both positive.
   * `inverted` — one column, but positive means spending. Some exports do this and it is the
   * single most damaging thing to get wrong, so it is explicit rather than inferred.
   */
  amountConvention: 'signed' | 'debit-credit' | 'inverted'
}

/**
 * Header patterns, in priority order within each role.
 *
 * Matching is case-insensitive and ignores punctuation, so `Transaction Date`, `transaction_date`
 * and `TRANSACTION-DATE` all hit the same rule.
 */
const HEADER_HINTS: ReadonlyArray<{ role: ColumnRole; patterns: readonly RegExp[] }> = [
  {
    role: 'date',
    patterns: [/^(transaction|posted|post|effective)?\s*date$/, /^date\b/, /\bdate$/],
  },
  {
    role: 'amount',
    patterns: [/^amount$/, /^transaction amount$/, /^value$/, /\bamount$/],
  },
  { role: 'debit', patterns: [/^debit$/, /^withdrawal$/, /^money out$/, /^outflow$/] },
  { role: 'credit', patterns: [/^credit$/, /^deposit$/, /^money in$/, /^inflow$/] },
  {
    role: 'description',
    patterns: [/^description$/, /^details$/, /^name$/, /^transaction$/, /\bdescription$/],
  },
  { role: 'payee', patterns: [/^payee$/, /^merchant$/, /^vendor$/] },
  { role: 'category', patterns: [/^category$/, /^categories$/, /^tag$/] },
  { role: 'account', patterns: [/^account$/, /^account name$/, /^account number$/] },
  { role: 'memo', patterns: [/^memo$/, /^note[s]?$/, /^comment[s]?$/] },
  { role: 'balance', patterns: [/^balance$/, /^net worth$/, /^total$/, /\bbalance$/] },
]

/** Lowercase, collapse punctuation and whitespace, so header variants compare equal. */
function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * Guesses a role for each column from its header.
 *
 * Each role is assigned at most once — the **first** column matching a role wins, so a file with
 * both `Date` and `Post Date` does not end up with two date columns silently fighting. Everything
 * unmatched becomes `ignore`, which is a visible default the user can change rather than a
 * silent one.
 */
export function guessMapping(headers: readonly string[]): ColumnMapping[] {
  const taken = new Set<ColumnRole>()
  const mapping: ColumnMapping[] = headers.map((_, columnIndex) => ({
    columnIndex,
    role: 'ignore' as ColumnRole,
  }))

  // Roles in hint order, so `date` claims its column before weaker patterns run.
  for (const hint of HEADER_HINTS) {
    if (taken.has(hint.role)) continue

    for (const pattern of hint.patterns) {
      const index = headers.findIndex(
        (header, columnIndex) =>
          mapping[columnIndex]?.role === 'ignore' && pattern.test(normalizeHeader(header)),
      )

      if (index !== -1) {
        mapping[index] = { columnIndex: index, role: hint.role }
        taken.add(hint.role)
        break
      }
    }
  }

  return mapping
}

export type MappingProblem = {
  severity: 'error' | 'warning'
  message: string
}

/**
 * Checks a mapping is usable before anything is staged.
 *
 * Errors block the import; warnings are shown and can be accepted. The distinction matters because
 * a missing description is cosmetic, while a missing amount means every row would import as zero —
 * silently, and looking like a real import that simply found nothing.
 */
export function validateMapping(
  mapping: readonly ColumnMapping[],
  kind: ImportKind,
): MappingProblem[] {
  const roles = new Set(mapping.map((column) => column.role))
  const problems: MappingProblem[] = []

  if (!roles.has('date')) {
    problems.push({ severity: 'error', message: 'A date column is required.' })
  }

  if (kind === 'transactions') {
    const hasAmount = roles.has('amount')
    const hasDebitCredit = roles.has('debit') || roles.has('credit')

    if (!hasAmount && !hasDebitCredit) {
      problems.push({
        severity: 'error',
        message: 'An amount column is required, or separate debit and credit columns.',
      })
    }

    if (hasAmount && hasDebitCredit) {
      problems.push({
        severity: 'error',
        message:
          'Choose either a single amount column or separate debit and credit columns, not both.',
      })
    }

    if (!roles.has('description') && !roles.has('payee')) {
      problems.push({
        severity: 'warning',
        message: 'Without a description or payee column, transactions will be hard to recognize.',
      })
    }
  }

  if (kind === 'balances' && !roles.has('balance')) {
    problems.push({ severity: 'error', message: 'A balance column is required.' })
  }

  const duplicates = findDuplicateRoles(mapping)
  for (const role of duplicates) {
    problems.push({
      severity: 'error',
      message: `More than one column is mapped to ${role}.`,
    })
  }

  return problems
}

function findDuplicateRoles(mapping: readonly ColumnMapping[]): ColumnRole[] {
  const seen = new Set<ColumnRole>()
  const duplicated = new Set<ColumnRole>()

  for (const column of mapping) {
    if (column.role === 'ignore') continue
    if (seen.has(column.role)) {
      duplicated.add(column.role)
    }
    seen.add(column.role)
  }

  return [...duplicated]
}

export function hasBlockingProblem(problems: readonly MappingProblem[]): boolean {
  return problems.some((problem) => problem.severity === 'error')
}

/**
 * Shipped presets.
 *
 * Deliberately thin: a preset is a starting mapping and a sign convention, not a parser. Adding
 * Monarch or YNAB is adding an entry here, and a file that matches no preset works identically —
 * it just starts from the header guess instead.
 *
 * The Empower mapping is left to the header guess rather than pinned to exact column names, since
 * their export format has changed before and a wrong hardcoded index is worse than a guess the
 * user can see and correct.
 */
export const IMPORT_PRESETS: readonly ImportPreset[] = [
  {
    id: 'empower',
    label: 'Empower Personal Dashboard',
    kind: 'transactions',
    amountConvention: 'signed',
  },
  { id: 'monarch', label: 'Monarch Money', kind: 'transactions', amountConvention: 'signed' },
  { id: 'mint', label: 'Mint', kind: 'transactions', amountConvention: 'debit-credit' },
  { id: 'ynab', label: 'YNAB', kind: 'transactions', amountConvention: 'debit-credit' },
  { id: 'custom', label: 'Something else', kind: 'transactions', amountConvention: 'signed' },

  /*
   * Balance history rather than transactions.
   *
   * One preset, because there is nothing to vary: a balance row has no direction and therefore no
   * amount convention to get backwards. `signed` is carried only to satisfy the shape — nothing in
   * the balance parser reads it.
   */
  { id: 'balances', label: 'Balance history', kind: 'balances', amountConvention: 'signed' },
]

export function findPreset(id: string): ImportPreset | undefined {
  return IMPORT_PRESETS.find((preset) => preset.id === id)
}
