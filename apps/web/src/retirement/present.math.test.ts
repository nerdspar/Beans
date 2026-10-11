import { describe, expect, it } from 'vitest'
import type { Projection, ScenarioProjection } from './api.js'
import {
  bandSeries,
  dashboardView,
  disclosures,
  fundedOutcome,
  headlineProjection,
  percentFromBasisPoints,
} from './present.js'

/**
 * Turning a projection into what the screens render.
 *
 * The case worth the file is a band drawn from values rather than from position. Every return rate
 * is editable, so a scenario called "Markets disappoint" can end up the most optimistic one — and
 * a band keyed to arrival order would then render upside down, with the fill inverted and the
 * reader told the opposite of the truth.
 *
 * Fixed years throughout (CLAUDE.md).
 */

const year = (y: number, total: string): ScenarioProjection['years'][number] => ({
  year: y,
  retired: y >= 2_040,
  total,
  spending: '-72000.00',
  socialSecurity: '0.00',
  portfolioNeed: '72000.00',
  withdrawals: '72000.00',
  tax: '0.00',
  contributions: '0.00',
  growth: '0.00',
  shortfall: '0.00',
  buckets: [{ treatment: 'taxable', balance: total }],
})

const scenario = (
  id: string,
  totals: string[],
  over: Partial<ScenarioProjection> = {},
): ScenarioProjection => ({
  scenarioId: id,
  name: id,
  terminalTotal: totals.at(-1) ?? '0.00',
  depletionYear: null,
  heldBack: '0.00',
  fundedRatioBasisPoints: 10_000,
  gap: '0.00',
  notModelled: ['required_minimum_distributions', 'social_security_taxation'],
  years: totals.map((total, index) => year(2_040 + index, total)),
  ...over,
})

describe('bandSeries', () => {
  it('takes low and high from the values, not the order they arrive in', () => {
    /*
     * The seeded three arrive ordered because the engine is monotonic in the return rate. But the
     * rates are editable, so here the one named "pessimistic" has been given the best returns. A
     * band keyed to position would draw this upside down.
     */
    const band = bandSeries(
      [
        scenario('pessimistic', ['900.00', '1000.00']),
        scenario('expected', ['500.00', '600.00']),
        scenario('optimistic', ['100.00', '200.00']),
      ],
      'expected',
    )

    expect(band).toEqual([
      { year: 2_040, low: '100.00', high: '900.00', headline: '500.00' },
      { year: 2_041, low: '200.00', high: '1000.00', headline: '600.00' },
    ])
  })

  it('compares exactly, rather than through a float', () => {
    // Money stays a decimal string all the way through. Two totals that differ in the last cent
    // above 2^53 must still order correctly, which a JSON number could not promise.
    const band = bandSeries(
      [
        scenario('a', ['90071992547409.91']),
        scenario('b', ['90071992547409.92']),
      ],
      'a',
    )

    expect(band[0]?.low).toBe('90071992547409.91')
    expect(band[0]?.high).toBe('90071992547409.92')
  })

  it('handles a negative total without flipping the band', () => {
    // A plan that overdraws can go negative. String comparison would put "-900.00" above "100.00".
    const band = bandSeries(
      [scenario('a', ['-900.00']), scenario('b', ['100.00'])],
      'a',
    )

    expect(band[0]?.low).toBe('-900.00')
    expect(band[0]?.high).toBe('100.00')
  })

  it('falls back to the first scenario when the headline id is unknown', () => {
    const band = bandSeries([scenario('a', ['100.00'])], 'missing')
    expect(band[0]?.headline).toBe('100.00')
  })

  it('is empty for no scenarios rather than throwing', () => {
    expect(bandSeries([], null)).toEqual([])
  })
})

describe('fundedOutcome', () => {
  it('reports a plan that lasts', () => {
    const outcome = fundedOutcome(scenario('a', ['100.00', '200.00']))
    expect(outcome).toEqual({ kind: 'covered', terminalTotal: '200.00' })
  })

  it('reports a plan that runs out, with the year and the gap', () => {
    /*
     * Flat facts, and the type makes them exclusive: a screen cannot render "covers the plan"
     * beside a depletion year, because the union has no shape that carries both.
     */
    const outcome = fundedOutcome(
      scenario('a', ['100.00'], {
        depletionYear: 2_051,
        gap: '180000.00',
        fundedRatioBasisPoints: 7_350,
      }),
    )

    expect(outcome).toEqual({
      kind: 'short',
      depletionYear: 2_051,
      gap: '180000.00',
      fundedRatioBasisPoints: 7_350,
    })
  })

  it('reports no horizon rather than calling an empty plan fully funded', () => {
    // Nothing to fund is not the same as fully funded, and the reassuring shape of a wrong number
    // is the problem.
    const outcome = fundedOutcome(scenario('a', ['100.00'], { fundedRatioBasisPoints: null }))
    expect(outcome).toEqual({ kind: 'no-horizon' })
  })
})

describe('percentFromBasisPoints', () => {
  it('keeps a decimal place only when there is one', () => {
    /*
     * Rounding everything to whole percents rendered the seeded 3.5% post-retirement return as
     * "4%", so the assumption shown beside the figures was not the one that produced them. Caught
     * by reading the rendered screen, not by a test.
     */
    expect(percentFromBasisPoints(350)).toBe('3.5%')
    expect(percentFromBasisPoints(2_200)).toBe('22%')
    expect(percentFromBasisPoints(10_000)).toBe('100%')
    expect(percentFromBasisPoints(7_350)).toBe('73.5%')
    expect(percentFromBasisPoints(0)).toBe('0%')
  })

  it('rounds to one decimal rather than inventing precision', () => {
    expect(percentFromBasisPoints(7_355)).toBe('73.6%')
    expect(percentFromBasisPoints(1_234)).toBe('12.3%')
  })
})

describe('headlineProjection', () => {
  it('uses the scenario marked default', () => {
    const projections = [scenario('a', ['100.00']), scenario('b', ['200.00'])]
    const headline = headlineProjection(projections, [
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: true },
    ])

    expect(headline?.scenarioId).toBe('b')
  })

  it('falls back to the middle by value, not to whichever sorts first', () => {
    /*
     * If the default were ever missing, leading with the first scenario would be arbitrary — and
     * about a third of the time it would be the optimistic one, which is the wrong accident for a
     * retirement headline to have.
     */
    const projections = [
      scenario('high', ['900.00']),
      scenario('low', ['100.00']),
      scenario('mid', ['500.00']),
    ]
    const headline = headlineProjection(projections, [
      { id: 'high', isDefault: false },
      { id: 'low', isDefault: false },
      { id: 'mid', isDefault: false },
    ])

    expect(headline?.scenarioId).toBe('mid')
  })

  it('is null for nothing', () => {
    expect(headlineProjection([], [])).toBeNull()
  })
})

describe('disclosures', () => {
  it('collects the declared gaps once each', () => {
    const factors = disclosures([scenario('a', ['1.00']), scenario('b', ['2.00'])])

    expect(factors).toHaveLength(2)
    expect(factors).toContain('required_minimum_distributions')
    expect(factors).toContain('social_security_taxation')
  })

  it('reports none when the projection declares none', () => {
    // Read from the response rather than hard-coded, so a factor that later becomes modelled stops
    // being mentioned without anyone editing this screen.
    expect(disclosures([scenario('a', ['1.00'], { notModelled: [] })])).toEqual([])
  })
})

describe('dashboardView', () => {
  const ready: Projection = {
    ready: true,
    startYear: 2_026,
    endYear: 2_041,
    unreviewedCategoryIds: ['groceries', null],
    monthsObserved: 12,
    annualizedFromPartialYear: false,
    projections: [
      scenario('low', ['100.00', '150.00']),
      scenario('mid', ['500.00', '600.00']),
      scenario('high', ['900.00', '1100.00']),
    ],
  }

  it('assembles everything the dashboard needs in one pass', () => {
    const view = dashboardView(ready, [{ id: 'mid', isDefault: true }], true)

    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') return

    expect(view.headline.scenarioId).toBe('mid')
    expect(view.terminalLow).toBe('150.00')
    expect(view.terminalHigh).toBe('1100.00')
    expect(view.unreviewedCount).toBe(2)
    expect(view.band).toHaveLength(2)
    expect(view.outcome.kind).toBe('covered')
  })

  it('reports not-started before anyone has opened the planner', () => {
    expect(dashboardView(undefined, [], false)).toEqual({ kind: 'not-started' })
  })

  it('passes the missing list through untouched', () => {
    // The wizard renders all of it. The first gap is rarely the only one.
    const view = dashboardView(
      { ready: false, missing: ['members', 'life_expectancy'] },
      [],
      true,
    )

    expect(view).toEqual({ kind: 'incomplete', missing: ['members', 'life_expectancy'] })
  })

  it('carries the partial-year flag so the screen can say the baseline was scaled', () => {
    const view = dashboardView(
      { ...ready, monthsObserved: 3, annualizedFromPartialYear: true },
      [{ id: 'mid', isDefault: true }],
      true,
    )

    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') return
    expect(view.annualizedFromPartialYear).toBe(true)
    expect(view.monthsObserved).toBe(3)
  })
})
