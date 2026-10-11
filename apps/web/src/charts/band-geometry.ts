/**
 * Geometry for a range band: a filled area between two series, with a line inside it.
 *
 * Pure and separate from the component, because the parts that are easy to get wrong are arithmetic
 * rather than markup — a band that closes in the wrong direction renders as a bowtie, and a flat
 * series divides by a zero range.
 *
 * Values arrive as `bigint` cents and are converted to numbers **only for pixel geometry**. That is
 * the one place a float is acceptable: a pixel is not money, and no figure computed here is ever
 * shown to anybody.
 */

export type BandInput = {
  /** The label along the x axis — a calendar year here. */
  year: number
  low: bigint
  high: bigint
  /** The line drawn inside the band. */
  headline: bigint
}

export type BandGeometry = {
  /** A closed path: along the top forward, back along the bottom. Empty for no points. */
  band: string
  /** An open path through the headline series. */
  line: string
  /** The value range the paths were scaled to, for the axis. */
  min: number
  max: number
}

/** Cents to a plain number, for pixel geometry only. Never for display. */
function toPixelUnits(cents: bigint): number {
  return Number(cents)
}

export function bandGeometry(
  points: readonly BandInput[],
  width: number,
  height: number,
): BandGeometry {
  if (points.length === 0) return { band: '', line: '', min: 0, max: 0 }

  const lows = points.map((point) => toPixelUnits(point.low))
  const highs = points.map((point) => toPixelUnits(point.high))

  /*
   * Zero is always included in the range.
   *
   * A band that never approaches zero would otherwise be drawn against a floor of its own minimum,
   * which makes a plan that merely dips look like one that ran out. For a chart whose entire
   * question is "does this reach zero", the axis has to show where zero is.
   */
  let min = Math.min(0, ...lows)
  let max = Math.max(0, ...highs)

  /*
   * A completely flat series has no range to scale against. Giving it one keeps the line in the
   * middle rather than dividing by zero and producing NaN coordinates, which render as nothing at
   * all with no error.
   */
  if (max === min) {
    max = max + 1
    min = min - 1
  }

  const span = max - min
  const step = points.length === 1 ? 0 : width / (points.length - 1)

  const x = (index: number): number => (points.length === 1 ? width / 2 : index * step)
  const y = (value: number): number => height - ((value - min) / span) * height

  const top = points.map((point, index) => `${x(index)},${y(toPixelUnits(point.high))}`)

  /*
   * Back along the bottom, reversed. Walking the low series forward instead would close the shape
   * across its own diagonal and render a bowtie — correct-looking at a glance when the band is
   * narrow, and obviously wrong once it widens.
   */
  const bottom = [...points]
    .map((point, index) => `${x(index)},${y(toPixelUnits(point.low))}`)
    .reverse()

  const line = points
    .map((point, index) => `${x(index)},${y(toPixelUnits(point.headline))}`)
    .join(' L ')

  return {
    band: `M ${[...top, ...bottom].join(' L ')} Z`,
    line: `M ${line}`,
    min,
    max,
  }
}
