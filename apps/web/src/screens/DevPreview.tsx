import { useState, type ReactNode } from 'react'
import { AreaChart } from '../charts/AreaChart.js'
import { SearchableSelect } from '../lib/SearchableSelect.js'

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

export function DevPreview(): ReactNode {
  const [narrow, setNarrow] = useState('')
  const [wide, setWide] = useState('')
  const [scrub, setScrub] = useState<number | null>(null)

  const scrubbed = scrub === null ? undefined : SERIES[scrub]

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
        />
      </section>
    </div>
  )
}
