import { describe, expect, it } from 'vitest'
import { sampleIndices } from './table-rows.js'

/**
 * The sample behind every chart's table fallback.
 *
 * Two properties carry the whole thing. The endpoints must always be present, because a reader
 * asking what a chart shows is asking where it started and where it ended before anything else. And
 * the indices must be strictly ascending and in range, because they are used to look up points —
 * a repeat renders the same row twice and reads as a flat stretch that never happened.
 */

describe('sampleIndices', () => {
  it('returns nothing for an empty series', () => {
    expect(sampleIndices(0, 30)).toEqual([])
  })

  it('returns the only point when there is one', () => {
    expect(sampleIndices(1, 30)).toEqual([0])
  })

  it('returns every index when the series already fits', () => {
    // Exact, not sampled — a five-point series has no summarising to do, and a caption claiming it
    // sampled would be a lie about data the reader can see all of.
    expect(sampleIndices(5, 30)).toEqual([0, 1, 2, 3, 4])
    expect(sampleIndices(30, 30)).toHaveLength(30)
  })

  it('keeps both endpoints when it samples', () => {
    const indices = sampleIndices(2914, 24)
    expect(indices[0]).toBe(0)
    expect(indices.at(-1)).toBe(2913)
  })

  it('never exceeds the limit', () => {
    for (const count of [31, 100, 365, 2914, 10_000]) {
      expect(sampleIndices(count, 24).length).toBeLessThanOrEqual(24)
    }
  })

  it('ascends strictly, so no point is listed twice', () => {
    // The failure this guards is silent: a duplicated index renders the same date and value on two
    // consecutive rows, which a reader interprets as a day where nothing moved.
    for (const count of [31, 47, 100, 365, 2914]) {
      const indices = sampleIndices(count, 24)
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]! > indices[i - 1]!).toBe(true)
      }
    }
  })

  it('stays inside the series', () => {
    for (const count of [31, 47, 100, 365, 2914]) {
      for (const index of sampleIndices(count, 24)) {
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThan(count)
      }
    }
  })

  it('treats a limit below two as two, keeping first and last', () => {
    expect(sampleIndices(100, 1)).toEqual([0, 99])
    expect(sampleIndices(100, 0)).toEqual([0, 99])
  })

  it('spaces the sample evenly rather than clustering at one end', () => {
    // A sampler that walked from the start and stopped would answer "what shape is this" with the
    // first month of an eight-year series.
    const indices = sampleIndices(101, 6)
    expect(indices).toEqual([0, 20, 40, 60, 80, 100])
  })
})
