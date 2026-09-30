/**
 * Account classification.
 *
 * Lives in `shared` rather than the API because the client computes net worth from its local
 * working set (ARCHITECTURE.md §7) — both sides must classify identically or the two will disagree
 * about what a household is worth.
 */

export const ACCOUNT_TYPES = [
  'depository',
  'credit',
  'loan',
  'mortgage',
  'investment',
  'other_asset',
  'other_liability',
] as const

export type AccountType = (typeof ACCOUNT_TYPES)[number]

/**
 * `after_tax` is **after-tax non-Roth money inside an employer plan**, not a taxable brokerage.
 *
 * Contributions are already-taxed basis; the earnings on them are taxed as ordinary income on
 * withdrawal. That makes it a third thing, distinct from both `traditional` (all taxable later) and
 * `roth` (none taxable later), and a 401(k) commonly holds all three at once. Folding it into
 * either neighbour would misstate the after-tax equivalent in a specific direction, and it is the
 * bucket the mega-backdoor rules are entirely about.
 */
export const TAX_TREATMENTS = [
  'taxable',
  'traditional',
  'roth',
  'after_tax',
  'hsa',
  'education',
  'none',
] as const

export type TaxTreatment = (typeof TAX_TREATMENTS)[number]

/**
 * Net worth sections, in display order.
 *
 * This is the order the net worth screen renders, and the order the scroll-linked category
 * behavior steps through. Empty sections are not rendered, but the order never changes.
 */
export const NET_WORTH_SECTIONS = [
  'cash',
  'investment',
  'credit_card',
  'loan',
  'mortgage',
  'other_assets',
  'other_liabilities',
] as const

export type NetWorthSection = (typeof NET_WORTH_SECTIONS)[number]

const SECTION_BY_TYPE: Record<AccountType, NetWorthSection> = {
  depository: 'cash',
  investment: 'investment',
  credit: 'credit_card',
  loan: 'loan',
  mortgage: 'mortgage',
  other_asset: 'other_assets',
  other_liability: 'other_liabilities',
}

/**
 * Liability types. **This is the only thing that decides asset vs liability.**
 *
 * Never classify by the sign of a balance. An overdrawn checking account has a negative balance and
 * is still a cash asset; classifying by sign would silently move it into the liabilities bar and
 * make the assets/liabilities split disagree with net worth (ARCHITECTURE.md §3.2).
 */
const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'credit',
  'loan',
  'mortgage',
  'other_liability',
])

export function isLiability(type: AccountType): boolean {
  return LIABILITY_TYPES.has(type)
}

export function isAsset(type: AccountType): boolean {
  return !isLiability(type)
}

export function sectionForType(type: AccountType): NetWorthSection {
  return SECTION_BY_TYPE[type]
}

/** Whether a section renders as a liability — drives the red chart fill and the negative total. */
export function isLiabilitySection(section: NetWorthSection): boolean {
  return (
    section === 'credit_card' ||
    section === 'loan' ||
    section === 'mortgage' ||
    section === 'other_liabilities'
  )
}

/**
 * A sensible `tax_treatment` default for a newly discovered account.
 *
 * Nothing in phase 1 reads this, but retirement projection depends on it entirely and backfilling
 * it across years of accounts is miserable — so it is populated from day one. The default is only a
 * starting point: investment accounts are genuinely ambiguous (a brokerage could be taxable, a
 * rollover IRA traditional), which is why the user is asked at account confirmation and can edit it
 * afterwards.
 */
export function defaultTaxTreatment(type: AccountType): TaxTreatment {
  switch (type) {
    case 'investment':
      return 'taxable'
    case 'depository':
    case 'credit':
    case 'loan':
    case 'mortgage':
    case 'other_asset':
    case 'other_liability':
      return 'none'
  }
}

/**
 * What each treatment is called, in the terms an account holder uses.
 *
 * Kept beside the enum rather than in a screen, because two of them name it now and a third label
 * for the same value is how "Traditional" and "Pre-tax" end up in the same app.
 */
export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  taxable: 'Taxable',
  traditional: 'Traditional (pre-tax)',
  roth: 'Roth (tax-free)',
  after_tax: 'After-tax (non-Roth)',
  hsa: 'HSA',
  education: 'Education (529)',
  none: 'Not applicable',
}
