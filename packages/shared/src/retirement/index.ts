export {
  carryBucketsForward,
  type BucketAnchor,
  type BucketBalance,
  type CarryForwardOptions,
  type ContributionRouting,
} from './buckets.js'

export {
  afterTaxEquivalent,
  type AfterTaxBreakdown,
  type AfterTaxOptions,
} from './after-tax.js'
export {
  retirementSpending,
  spendingInYear,
  type RetirementSpending,
  type RetirementSpendingOptions,
  type SpendingAssumption,
  type SpendingComponent,
} from './spending.js'
export {
  DEFAULT_WITHDRAWAL_ORDER,
  projectScenario,
  projectScenarios,
  type ProjectionInput,
  type ProjectionMember,
  type ProjectionScenario,
  type ProjectionYear,
  type ScenarioProjection,
  type UnmodelledFactor,
} from './projection.js'

export { grossUpForTax, grow, scaleSigned } from './rates.js'

export { SEED_SCENARIOS, type SeedScenario } from './scenarios.js'

export {
  PLACEHOLDER_VALUE,
  REFERENCE_DEFINITIONS,
  lookupReference,
  referenceReadiness,
  type ReferenceDefinition,
  type ReferenceKey,
  type ReferenceLookup,
  type ReferenceRow,
  type ReferenceUnit,
} from './reference.js'
