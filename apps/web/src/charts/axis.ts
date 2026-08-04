/**
 * Axis arithmetic, shared by every chart that draws one.
 *
 * Extracted from AreaChart when a second chart needed the same labels. Two implementations of
 * "which values get a gridline" is how two charts of the same data end up with different ticks and
 * quietly imply they are measuring different things.
 */

/** How far the axis will go to keep its labels distinct before giving up. */
const MAX_LABEL_DIGITS = 4

/**
 * The fewest decimal places that keep every tick label different from its neighbours.
 *
 * Compact notation collapses on a narrow domain: an axis running $1.006M to $1.021M renders every
 * tick as `$1.01M` at two places, and four gridlines end up sharing one label. Rather than pick a
 * precision globally — too much everywhere else, to fix the worst case here — the axis tries
 * increasing precision until its own labels separate.
 *
 * Duplicates can survive: a genuinely flat series has identical ticks and no precision fixes that.
 * Stopping at a bound rather than looping is what makes that harmless.
 */
export function labelPrecision(values: readonly bigint[], format: (cents: bigint, digits: number) => string): number {
  for (let digits = 0; digits < MAX_LABEL_DIGITS; digits += 1) {
    const labels = values.map((value) => format(value, digits))
    if (new Set(labels).size === labels.length) {
      return digits
    }
  }

  return MAX_LABEL_DIGITS
}


/**
 * Picks tick values a person would choose.
 *
 * Dividing the domain into five equal parts gives arithmetically correct but unreadable labels —
 * `-$817.12K`, `-$820.06K`, `-$823K`. An axis exists to convey scale at a glance, and irregular
 * values defeat that: the reader ends up parsing each label instead of absorbing the range.
 *
 * So the step is snapped to 1, 2, 2.5 or 5 times a power of ten, and ticks land on multiples of it.
 * The chart's own domain still comes from the data — only the labelled lines are rounded.
 */
export function niceTicks(min: number, max: number, target: number): number[] {
  const span = max - min
  if (span <= 0 || !Number.isFinite(span)) {
    return [min]
  }

  const rough = span / (target - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude

  /*
   * Nearest nice number, not the next one up. Always rounding up overshoots: a span needing a step
   * of 2.9 gets 5, which halves the gridlines and leaves the axis sparse enough to stop conveying
   * scale. Rounding to nearest keeps the count close to what was asked for.
   */
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude

  const ticks: number[] = []
  // Start at the first multiple of `step` at or above the domain floor.
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push(value)
  }

  // A very narrow domain can round to nothing inside it; fall back rather than drawing no axis.
  return ticks.length === 0 ? [min, max] : ticks
}

