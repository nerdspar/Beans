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

export const TAX_TREATMENTS = [
  'taxable',
  'traditional',
  'roth',
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
