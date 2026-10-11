/**
 * The three scenarios a new plan starts with.
 *
 * **Starting points, not forecasts.** Every one is editable, the user can add their own, and the
 * numbers are shown on screen next to the figures they produce. The reason there are three rather
 * than one is that the output is a band: a single curve through thirty years of unknown returns
 * implies a precision that does not exist.
 *
 * These live here, beside the engine, rather than in the copy catalogue. They are **initial row
 * values** rather than interface strings — the moment a household is created these become rows the
 * user renames and re-rates, and nothing reads them to render a label afterwards. A name in the
 * copy catalogue that only ever reaches the database once would be in the wrong place.
 *
 * ---
 *
 * **Real returns, net of inflation**, which is why they look low next to the numbers in
 * advertisements. A nominal 8% and a real 5% describe the same portfolio in an era of 3% inflation,
 * and only one of them can be compared against spending measured in today's dollars.
 *
 * Post-retirement is lower than pre-retirement in all three because most people de-risk on
 * approach. These are **modelling assumptions, not reference data** — unlike a contribution limit
 * there is no authoritative figure to look up and no wrong answer to get caught out by, which is
 * exactly why they are editable and visible rather than buried.
 */
export type SeedScenario = {
  /** Stable key, so a seeded row can be recognised later even after it is renamed. */
  key: 'pessimistic' | 'expected' | 'optimistic'
  name: string
  preRetirementReturnBasisPoints: number
  postRetirementReturnBasisPoints: number
  isDefault: boolean
  sortOrder: number
}

export const SEED_SCENARIOS: readonly SeedScenario[] = [
  {
    key: 'pessimistic',
    name: 'Markets disappoint',
    preRetirementReturnBasisPoints: 200,
    postRetirementReturnBasisPoints: 100,
    isDefault: false,
    sortOrder: 0,
  },
  {
    /**
     * The default, and the one the headline figure comes from.
     *
     * Deliberately the middle of the three rather than the optimistic one. Which scenario a planner
     * picks for its headline is the most consequential choice it makes, and picking the flattering
     * one is how these tools end up being reassuring rather than useful.
     */
    key: 'expected',
    name: 'Markets behave',
    preRetirementReturnBasisPoints: 500,
    postRetirementReturnBasisPoints: 350,
    isDefault: true,
    sortOrder: 1,
  },
  {
    key: 'optimistic',
    name: 'Markets are kind',
    preRetirementReturnBasisPoints: 700,
    postRetirementReturnBasisPoints: 500,
    isDefault: false,
    sortOrder: 2,
  },
]
