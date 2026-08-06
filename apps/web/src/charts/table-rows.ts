/**
 * Choosing which points a chart's table fallback lists.
 *
 * Every chart needs a table fallback, and the naive reading of that is one row per point. On the net
 * worth chart that is eight years of days — close to three thousand rows, in the DOM, hidden, on a
 * screen that also carries a chart. It costs every reader something and serves the one it was meant
 * for worst: nobody arrows through three thousand rows to learn that savings went up.
 *
 * So the table is an **overview** — bounded, evenly spaced, always including the first and last
 * points, because the endpoints are the two a reader actually wants and an even sample can miss
 * them by one. Detail is already covered: the chart itself is a `slider` whose `aria-valuetext`
 * describes every single point, so nothing is unreachable. The table answers "what shape is this",
 * the slider answers "what was it on the 14th", and the caption says how many points it sampled so
 * the summary is never mistaken for the whole series.
 */

/**
 * How many rows a chart's table fallback lists.
 *
 * Two dozen is about a screen of rows, and enough to carry the shape of an eight-year series
 * without becoming something nobody will read to the end of. Shared so the charts agree — a reader
 * moving between two of them should not find one summarised four times as finely as the other.
 */
export const CHART_TABLE_ROWS = 24

/**
 * Evenly spaced indices into a series of `count` points, at most `max` of them, always including
 * the first and the last.
 *
 * Returns every index when the series already fits, so a short series is exact rather than sampled.
 */
export function sampleIndices(count: number, max: number): readonly number[] {
  if (count <= 0) return []
  if (count === 1) return [0]

  /*
   * Two is the floor. A one-row sample of a series would have to drop either the first point or the
   * last, and a table fallback that reports only where something ended is worse than none — it
   * reads as a complete answer.
   */
  const limit = Math.max(2, Math.floor(max))
  if (count <= limit) return Array.from({ length: count }, (_, index) => index)

  /*
   * Spanning `limit - 1` gaps rather than `limit` is what pins both ends: index 0 lands on 0 and
   * index `limit - 1` lands on `count - 1` exactly, with no rounding drift at the edges.
   */
  const step = (count - 1) / (limit - 1)
  const indices: number[] = []
  for (let position = 0; position < limit; position += 1) {
    indices.push(Math.round(position * step))
  }
  return indices
}
