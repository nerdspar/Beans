/**
 * The statutory figures the retirement feature needs, and the gate that stops them being used
 * before a human has checked them.
 *
 * **Every figure here is a placeholder until somebody approves it.** Contribution limits, phaseout
 * thresholds, catch-up tiers and RMD ages change every year, several have phased in on staggered
 * schedules with at least one delay along the way, and a model's recollection of them is exactly
 * wrong enough to be dangerous. A wrong limit does not produce an error; it produces a confident,
 * incorrect statement about somebody's real money.
 *
 * So this module ships the *shape* of the data — which figures are needed, what each one means,
 * where to find it — and refuses to supply a number until the row carrying it has been verified.
 */

export type ReferenceUnit = 'cents' | 'years' | 'basis_points'

export type ReferenceKey =
  | 'employee_deferral_limit'
  | 'employee_deferral_catch_up_50'
  | 'employee_deferral_catch_up_higher_tier'
  | 'catch_up_age_threshold'
  | 'higher_catch_up_age_min'
  | 'higher_catch_up_age_max'
  | 'total_annual_additions_limit'
  | 'ira_contribution_limit'
  | 'ira_catch_up_50'
  | 'hsa_contribution_limit_self'
  | 'hsa_contribution_limit_family'
  | 'hsa_catch_up_55'
  | 'rmd_start_age'
  | 'social_security_max_taxable_share'

export type ReferenceDefinition = {
  key: ReferenceKey
  unit: ReferenceUnit
  /** What a reviewer is being asked to confirm. Specific enough to look up without guessing. */
  label: string
  /** Where to find it. **Part of what gets verified** — a stale link is a wrong source. */
  sourceUrl: string
}

/**
 * The value every unverified row carries.
 *
 * Deliberately absurd, and that is the point. A placeholder of `23500_00` looks checked, and the
 * next person to read it has no way to know it was invented — which is precisely the failure the
 * reference-data rule exists to prevent. One cent, or one year, is self-evidently not a real
 * figure, so if it ever escaped the gate it would read as broken rather than as an answer.
 *
 * It is never shown as money anywhere. The review screen renders the row as "needs a figure".
 */
export const PLACEHOLDER_VALUE = 1n

/**
 * Every figure the feature needs, as a review checklist.
 *
 * Seeded unverified so the operator has a concrete list rather than an empty table and a memory of
 * a conversation. Adding a key here adds a row to review; nothing starts working until it is
 * approved.
 */
export const REFERENCE_DEFINITIONS: readonly ReferenceDefinition[] = [
  {
    key: 'employee_deferral_limit',
    unit: 'cents',
    label: 'Elective deferral limit for 401(k), 403(b) and most 457 plans',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-401k-and-profit-sharing-plan-contribution-limits',
  },
  {
    key: 'employee_deferral_catch_up_50',
    unit: 'cents',
    label: 'Additional elective deferral allowed from the standard catch-up age',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-catch-up-contributions',
  },
  {
    key: 'employee_deferral_catch_up_higher_tier',
    unit: 'cents',
    label: 'Additional elective deferral for the higher age band, where one applies',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-catch-up-contributions',
  },
  {
    key: 'catch_up_age_threshold',
    unit: 'years',
    label: 'Age at which the standard catch-up contribution becomes available',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-catch-up-contributions',
  },
  {
    key: 'higher_catch_up_age_min',
    unit: 'years',
    label: 'First age of the higher catch-up band',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-catch-up-contributions',
  },
  {
    key: 'higher_catch_up_age_max',
    unit: 'years',
    label: 'Last age of the higher catch-up band',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-catch-up-contributions',
  },
  {
    key: 'total_annual_additions_limit',
    unit: 'cents',
    label: 'Combined employee, employer and after-tax annual additions limit',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-401k-and-profit-sharing-plan-contribution-limits',
  },
  {
    key: 'ira_contribution_limit',
    unit: 'cents',
    label: 'Annual IRA contribution limit',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-ira-contribution-limits',
  },
  {
    key: 'ira_catch_up_50',
    unit: 'cents',
    label: 'Additional IRA contribution allowed at the catch-up age',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-ira-contribution-limits',
  },
  {
    key: 'hsa_contribution_limit_self',
    unit: 'cents',
    label: 'HSA contribution limit, self-only coverage',
    sourceUrl: 'https://www.irs.gov/publications/p969',
  },
  {
    key: 'hsa_contribution_limit_family',
    unit: 'cents',
    label: 'HSA contribution limit, family coverage',
    sourceUrl: 'https://www.irs.gov/publications/p969',
  },
  {
    key: 'hsa_catch_up_55',
    unit: 'cents',
    label: 'Additional HSA contribution allowed at the HSA catch-up age',
    sourceUrl: 'https://www.irs.gov/publications/p969',
  },
  {
    key: 'rmd_start_age',
    unit: 'years',
    label: 'Age at which required minimum distributions begin',
    sourceUrl:
      'https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs',
  },
  {
    key: 'social_security_max_taxable_share',
    unit: 'basis_points',
    label: 'Maximum share of Social Security benefits that can be taxable',
    sourceUrl: 'https://www.irs.gov/publications/p915',
  },
]

export type ReferenceRow = {
  key: string
  taxYear: number
  value: bigint
  unit: ReferenceUnit
  sourceUrl: string
  /**
   * When a human last entered a figure here. Null while the row still carries its placeholder.
   *
   * Distinct from `verifiedAt`, and the distinction earns its keep: a figure somebody typed and
   * then withdrew approval from is real and worth keeping on screen to compare against, while a
   * row nobody has touched holds a deliberately absurd placeholder that must never be rendered.
   */
  retrievedAt: Date | null
  /** Null means nobody has approved this figure, which blocks every read of it. */
  verifiedAt: Date | null
}

/**
 * The result of asking for a figure. A union, so "not available" cannot be mistaken for a number.
 *
 * The alternative — returning `bigint | null` — puts the burden on every caller to remember the
 * null check, and the one that forgets produces a confident wrong answer rather than an error.
 */
export type ReferenceLookup =
  | { status: 'ok'; value: bigint; sourceUrl: string; taxYear: number }
  /** No row at all for that year. Never falls back to another year. */
  | { status: 'missing'; key: string; taxYear: number }
  /** A row exists but nobody has checked it against its source. */
  | { status: 'unverified'; key: string; taxYear: number; sourceUrl: string }
  /** The row is stored in a different unit than the caller expected — a bug, not a data gap. */
  | { status: 'wrong_unit'; key: string; expected: ReferenceUnit; actual: ReferenceUnit }

/**
 * Looks up one figure for one tax year.
 *
 * **Never falls back to an adjacent year.** Last year's limit is not this year's limit, and a
 * silent fallback is indistinguishable from a correct answer right up until somebody acts on it.
 * A missing year is reported as missing so the UI can say "not yet updated for 2027".
 */
export function lookupReference(
  rows: readonly ReferenceRow[],
  key: ReferenceKey,
  taxYear: number,
  expectedUnit: ReferenceUnit,
): ReferenceLookup {
  const row = rows.find((candidate) => candidate.key === key && candidate.taxYear === taxYear)

  if (row === undefined) return { status: 'missing', key, taxYear }

  /*
   * The unit is checked before the verification gate on purpose. A unit mismatch is a programming
   * error — an age about to be read as cents — and reporting it as "unverified" would hide a bug
   * behind a data-entry task that could never fix it.
   */
  if (row.unit !== expectedUnit) {
    return { status: 'wrong_unit', key, expected: expectedUnit, actual: row.unit }
  }

  if (row.verifiedAt === null) {
    return { status: 'unverified', key, taxYear, sourceUrl: row.sourceUrl }
  }

  return { status: 'ok', value: row.value, sourceUrl: row.sourceUrl, taxYear }
}

/**
 * Whether every figure the feature needs is approved for a year.
 *
 * Drives the banner. One unapproved row is enough to warrant it: a projection resting on eleven
 * checked figures and one invented one is not eleven-twelfths right, it is wrong.
 */
export function referenceReadiness(
  rows: readonly ReferenceRow[],
  taxYear: number,
): { ready: boolean; missing: ReferenceKey[]; unverified: ReferenceKey[] } {
  const missing: ReferenceKey[] = []
  const unverified: ReferenceKey[] = []

  for (const definition of REFERENCE_DEFINITIONS) {
    const result = lookupReference(rows, definition.key, taxYear, definition.unit)
    if (result.status === 'missing' || result.status === 'wrong_unit') missing.push(definition.key)
    else if (result.status === 'unverified') unverified.push(definition.key)
  }

  return { ready: missing.length === 0 && unverified.length === 0, missing, unverified }
}
