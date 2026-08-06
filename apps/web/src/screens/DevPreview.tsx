import { useState, type ReactNode } from 'react'
import { AreaChart } from '../charts/AreaChart.js'
import { CategoryChart } from '../charts/CategoryChart.js'
import { CumulativeFlow } from '../charts/CumulativeFlow.js'
import { MonthlyBars } from '../charts/MonthlyBars.js'
import { SearchableSelect } from '../lib/SearchableSelect.js'
import { cn } from '../lib/cn.js'

/**
 * A workbench for looking at components that normally sit behind sign-in.
 *
 * **Development only.** Rendered before the auth gate in `App.tsx`, guarded by `import.meta.env.DEV`
 * so it is dead code in a production build — the whole module is tree-shaken out, and the route
 * never exists on a real deployment.
 *
 * It exists because the alternative was shipping interaction work unseen. A dropdown's width, a
 * chart's drag behaviour and a panel's overflow are not things typechecking has an opinion about,
 * and every screen that would show them requires a household behind a login. Fixtures are enough:
 * what is being judged here is layout and gesture, not data.
 */

/** Forty, because the width problem only appears at the scale that prompted it. */
const ACCOUNTS = [
  { label: 'Family Checking', hint: 'Bank of America' },
  { label: '18 Atlantic Xing', hint: '18 Atlantic Xing' },
  { label: 'Joint 3.30% Cash Account', hint: 'Wealthfront' },
  { label: 'Individual Brokerage Account', hint: 'Fidelity Investments' },
  { label: 'CDW Rollover IRA — Ending in 4417', hint: 'Fidelity Investments' },
  { label: 'Joint (XRPV)', hint: 'Wealthfront' },
  { label: 'Joint Automated Investing Account', hint: 'Wealthfront' },
  { label: 'Joint Cash Account — Ending in 5497', hint: 'Wealthfront' },
  { label: 'Rental Checking — Ending in 2155', hint: 'Bank of America' },
  { label: 'Adv Relationship Banking — Ending in 8842', hint: 'Bank of America' },
  { label: 'Advantage Savings', hint: 'Bank of America' },
  { label: 'Amazon Card', hint: 'Chase' },
  ...Array.from({ length: 28 }, (_, index) => ({
    label: `Filler Account Number ${index + 1}`,
    hint: 'Some Institution',
  })),
].map((account, index) => ({ value: `acc-${index}`, ...account }))

/** A year of daily points, so the scrubber has something realistic to step through. */
const SERIES = Array.from({ length: 365 }, (_, index) => {
  const date = new Date(Date.UTC(2025, 7, 5) + index * 86_400_000)
  const wave = Math.sin(index / 30) * 40_000_00 + index * 2_000_00
  return {
    date: date.toISOString().slice(0, 10),
    value: BigInt(Math.round(260_000_00 + wave)),
  }
})

const money = (cents: bigint): string =>
  `$${Math.round(Number(cents) / 100).toLocaleString()}`

/** A year with one outlier month, which is the case the average line exists to make readable. */
const MONTHS = Array.from({ length: 12 }, (_, index) => {
  const outlier = index === 4
  const incomeCents = BigInt(outlier ? 14_000_000 : 900_000 + index * 20_000)
  const spendingCents = BigInt(outlier ? -10_500_000 : -(700_000 + index * 15_000))
  return {
    month: `2025-${String(index + 1).padStart(2, '0')}`,
    incomeCents,
    spendingCents,
    netCents: incomeCents + spendingCents,
  }
})

/** A month in progress: 31 days of window, 18 of them elapsed. */
const THIS_MONTH = Array.from({ length: 31 }, (_, index) => {
  const step = index < 2 ? 0 : index < 12 ? -12_000 : index < 13 ? 180_000 : -9_000
  return { date: `2026-08-${String(index + 1).padStart(2, '0')}`, step }
}).reduce<Array<{ date: string; cumulativeCents: bigint }>>((points, day) => {
  const previous = points.at(-1)?.cumulativeCents ?? 0n
  points.push({ date: day.date, cumulativeCents: previous + BigInt(day.step) })
  return points
}, [])

/** The month before, which ends lower — the case the comparison line exists to show. */
const LAST_MONTH = THIS_MONTH.map((point, index) => ({
  date: point.date,
  cumulativeCents: point.cumulativeCents - BigInt(index * 9_000),
}))

/** Enough dates to scroll several groups past, which is where the header overlap showed. */
const LIST_DAYS = Array.from({ length: 10 }, (_, day) => ({
  date: `2026-08-${String(20 - day).padStart(2, '0')}`,
  rows: Array.from({ length: 3 }, (_, index) => ({
    id: `${day}-${index}`,
    payee: `Merchant ${day}-${index} with a fairly long name`,
    category: 'General Merchandise',
    cents: BigInt(-(1200 + index * 731)),
  })),
}))

export function DevPreview(): ReactNode {
  const [narrow, setNarrow] = useState('')
  const [wide, setWide] = useState('')
  const [scrub, setScrub] = useState<number | null>(null)
  const [categoryScrub, setCategoryScrub] = useState<number | null>(null)
  const [flowScrub, setFlowScrub] = useState<number | null>(null)
  const [monthScrub, setMonthScrub] = useState<number | null>(null)
  const [pinnedMonth, setPinnedMonth] = useState<number | null>(null)

  const scrubbed = scrub === null ? undefined : SERIES[scrub]
  const category = categoryScrub === null ? undefined : SERIES[categoryScrub]
  const flowPoint = flowScrub === null ? undefined : THIS_MONTH[flowScrub]
  const monthRead = monthScrub === null ? undefined : MONTHS[monthScrub]

  return (
    <div className="mx-auto max-w-2xl space-y-10 p-6">
      <h1 className="text-xl font-semibold">Component preview</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">SearchableSelect — narrow trigger, left aligned</h2>
        <p className="text-xs text-slate-500">As on Activity: trigger is 60% width.</p>
        <div className="flex justify-start">
          <SearchableSelect
            className="max-w-[60%]"
            value={narrow}
            onChange={setNarrow}
            label="All accounts"
            options={[{ value: '', label: 'All accounts' }, ...ACCOUNTS]}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">SearchableSelect — right aligned in a row</h2>
        <p className="text-xs text-slate-500">As on Import matching: w-56, anchored to its end.</p>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <span className="truncate text-sm font-medium">Joint Cash Account — Ending in 5497</span>
          <SearchableSelect
            align="end"
            className="w-56 shrink-0"
            value={wide}
            onChange={setWide}
            label="Match account"
            options={[{ value: '', label: 'Skip' }, ...ACCOUNTS]}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Transaction list — date groups</h2>
        <ul className="max-h-64 overflow-y-auto">
          {LIST_DAYS.map((group) => (
            <li key={group.date} data-on-or-before={group.date}>
              <h3
                className={cn(
                  'sticky -top-2 z-20 border-b pb-2 pt-4 text-xs font-semibold tabular-nums',
                  'border-slate-200 bg-slate-50 text-slate-700',
                  'dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300',
                )}
              >
                {group.date}
              </h3>
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {group.rows.map((row) => (
                  <li key={row.id} className="flex items-baseline justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{row.payee}</p>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {row.category}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums">{money(row.cents)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">CumulativeFlow — month to date vs the month before</h2>
        <p className="text-xs tabular-nums text-slate-500">
          {flowPoint === undefined ? 'Not reading' : `${flowPoint.date} · ${money(flowPoint.cumulativeCents)}`}
        </p>
        <CumulativeFlow
          series={THIS_MONTH}
          comparison={LAST_MONTH}
          color="#38bdf8"
          formatValue={(cents) => money(cents)}
          scrubIndex={flowScrub}
          onScrub={setFlowScrub}
          describePoint={(index) => THIS_MONTH[index]?.date ?? ''}
          scrubLabel="Running total"
          tableLabel="Running total"
          comparisonLabel="Month before"
          elapsedCount={18}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">MonthlyBars — net (both directions)</h2>
        <p className="text-xs tabular-nums text-slate-500">
          {monthRead === undefined ? 'Not reading' : `${monthRead.month} · ${money(monthRead.netCents)}`}
        </p>
        <MonthlyBars
          periods={MONTHS}
          mode="net"
          formatValue={money}
          averageLabel={(amount) => `Avg ${amount}`}
          scrubIndex={monthScrub}
          onScrub={setMonthScrub}
          onSelect={(index, viaTap) =>
            setPinnedMonth((current) =>
              viaTap && current === index ? null : index,
            )
          }
          selectedIndex={pinnedMonth}
          describePoint={(index) => MONTHS[index]?.month ?? ''}
          scrubLabel="Read by month"
          tableLabel="Net"
        />
        <p className="text-xs text-slate-500">
          Pinned: {pinnedMonth === null ? 'none' : (MONTHS[pinnedMonth]?.month ?? '')}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">MonthlyBars — expenses only</h2>
        <MonthlyBars
          periods={MONTHS}
          mode="spending"
          formatValue={(cents) => money(-cents)}
          averageLabel={(amount) => `Avg ${amount}`}
        />
      </section>

      <section className="space-y-2">
        {/* The wrapper the account detail screen uses — it has to pass the scrub props through. */}
        <h2 className="text-sm font-semibold">CategoryChart — scrubber passthrough</h2>
        <p className="text-xs tabular-nums text-slate-500">
          {category === undefined ? 'Not reading' : `${category.date} · ${category.value}`}
        </p>
        <CategoryChart
          categoryKey="preview"
          series={SERIES}
          color="#34d399"
          formatValue={(cents) => `$${Math.round(Number(cents) / 100)}`}
          height={140}
          scrubIndex={categoryScrub}
          onScrub={setCategoryScrub}
          describePoint={(index) => SERIES[index]?.date ?? ''}
          scrubLabel="Read account by date"
          tableLabel="Everyday Checking"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">AreaChart — scrubber</h2>
        <p className="text-xs tabular-nums text-slate-500">
          {scrubbed === undefined ? 'Not reading' : `${scrubbed.date} · ${scrubbed.value}`}
        </p>
        <AreaChart
          series={SERIES}
          color="#38bdf8"
          formatValue={(cents, digits) =>
            `$${(Number(cents) / 100).toLocaleString(undefined, {
              maximumFractionDigits: digits,
              notation: 'compact',
            })}`
          }
          height={220}
          scrubIndex={scrub}
          onScrub={setScrub}
          completeFromIndex={120}
          describePoint={(index) => SERIES[index]?.date ?? ''}
          scrubLabel="Read by date"
          tableLabel="Net worth"
        />
      </section>
    </div>
  )
}
