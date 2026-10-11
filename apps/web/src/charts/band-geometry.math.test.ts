import { describe, expect, it } from 'vitest'
import { bandGeometry, type BandInput } from './band-geometry.js'

/**
 * Range-band geometry.
 *
 * The cases here are the ones that render as something plausible-but-wrong rather than as an error:
 * a band closed in the wrong direction is a bowtie, a flat series divides by zero and draws
 * nothing, and an axis that excludes zero makes a plan that dips look like one that ran out.
 */

const point = (year: number, low: bigint, high: bigint, headline: bigint): BandInput => ({
  year,
  low,
  high,
  headline,
})

/** Pulls "x,y" pairs out of a path, as numbers, for geometry assertions. */
function coords(path: string): { x: number; y: number }[] {
  return [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }))
}

describe('bandGeometry', () => {
  it('closes the band by walking back along the bottom', () => {
    /*
     * The bowtie case. Walking the low series forward would close the shape across its own
     * diagonal — which looks almost right while the band is narrow and is obviously broken once it
     * widens.
     *
     * Two points means four vertices: high[0], high[1], low[1], low[0]. The third x must return to
     * the right edge and the fourth to the left.
     */
    const geometry = bandGeometry(
      [point(2_040, 0n, 100n, 50n), point(2_041, 0n, 100n, 50n)],
      100,
      50,
    )

    const vertices = coords(geometry.band)
    expect(vertices).toHaveLength(4)
    expect(vertices[0]?.x).toBe(0)
    expect(vertices[1]?.x).toBe(100)
    expect(vertices[2]?.x).toBe(100)
    expect(vertices[3]?.x).toBe(0)
    expect(geometry.band.endsWith('Z')).toBe(true)
  })

  it('puts the high series above the low series on screen', () => {
    // SVG y grows downward, so "above" means a smaller y. Getting this inverted draws the band
    // upside down with the fill on the wrong side of the line.
    const geometry = bandGeometry([point(2_040, 100n, 900n, 500n)], 100, 100)
    const vertices = coords(geometry.band)

    const high = vertices[0]!
    const low = vertices[1]!
    expect(high.y).toBeLessThan(low.y)
  })

  it('always includes zero in the range', () => {
    /*
     * The whole question this chart answers is whether the plan reaches zero. A band drawn against
     * a floor of its own minimum would make a plan that merely dips look like one that ran out.
     */
    const geometry = bandGeometry(
      [point(2_040, 500_000n, 900_000n, 700_000n)],
      100,
      100,
    )

    expect(geometry.min).toBe(0)
    expect(geometry.max).toBe(900_000)
  })

  it('includes zero from above when the plan goes negative', () => {
    const geometry = bandGeometry([point(2_040, -50_000n, -10_000n, -30_000n)], 100, 100)

    expect(geometry.min).toBe(-50_000)
    expect(geometry.max).toBe(0)
  })

  it('does not divide by zero on a completely flat series', () => {
    /*
     * A flat band has no range to scale against. Dividing by it yields NaN coordinates, which SVG
     * renders as nothing at all — no error, no drawing, no clue why.
     */
    const geometry = bandGeometry(
      [point(2_040, 0n, 0n, 0n), point(2_041, 0n, 0n, 0n)],
      100,
      50,
    )

    for (const vertex of coords(geometry.band)) {
      expect(Number.isFinite(vertex.x)).toBe(true)
      expect(Number.isFinite(vertex.y)).toBe(true)
    }
    for (const vertex of coords(geometry.line)) {
      expect(Number.isFinite(vertex.y)).toBe(true)
    }
  })

  it('centres a single point rather than pinning it to the left edge', () => {
    // One year is a degenerate chart, but it happens the moment somebody sets a one-year horizon,
    // and a dot in the corner reads as a bug.
    const geometry = bandGeometry([point(2_040, 0n, 100n, 50n)], 100, 50)

    expect(coords(geometry.line)[0]?.x).toBe(50)
  })

  it('draws the headline line through every point', () => {
    const geometry = bandGeometry(
      [
        point(2_040, 0n, 100n, 50n),
        point(2_041, 0n, 100n, 60n),
        point(2_042, 0n, 100n, 70n),
      ],
      100,
      50,
    )

    expect(coords(geometry.line)).toHaveLength(3)
    // Open path, not closed: a line is not an area.
    expect(geometry.line.endsWith('Z')).toBe(false)
  })

  it('spaces points evenly across the full width', () => {
    const geometry = bandGeometry(
      [
        point(2_040, 0n, 100n, 50n),
        point(2_041, 0n, 100n, 50n),
        point(2_042, 0n, 100n, 50n),
      ],
      200,
      50,
    )

    expect(coords(geometry.line).map((vertex) => vertex.x)).toEqual([0, 100, 200])
  })

  it('is empty for no points rather than producing a malformed path', () => {
    // An empty `d` attribute is valid and draws nothing. "M  Z" is not, and logs a console error.
    expect(bandGeometry([], 100, 50)).toEqual({ band: '', line: '', min: 0, max: 0 })
  })

  it('handles a portfolio large enough to exceed a float’s integer range', () => {
    /*
     * Pixels are the one place a float is acceptable, and this is why it is safe: the values only
     * have to order and scale correctly, not round-trip. A ten-billion-dollar portfolio still
     * produces finite coordinates inside the viewport.
     */
    const geometry = bandGeometry(
      [point(2_040, 0n, 1_000_000_000_000n, 500_000_000_000n)],
      100,
      100,
    )

    const vertices = coords(geometry.band)
    expect(vertices.every((vertex) => Number.isFinite(vertex.y))).toBe(true)
    expect(vertices[0]?.y).toBe(0)
  })
})
