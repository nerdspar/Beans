# Beans — Retirement Planning Spec

Companion to `beans-build-prompt.md`. Read that first; everything here assumes its conventions (signed integer cents, envelope encryption, household tenancy, client-side working set, plain code naming with personality confined to empty and error states).

Same process as before: read this whole document, ask me questions about anything ambiguous or anything you disagree with, propose the schema additions and wait for approval, then build in the phase order at the bottom.

## Standing note: the codebase wins

This spec was written outside the repo, in a separate conversation, without visibility into the code you have actually built. It describes intent, not ground truth. You have context I did not have when writing it.

So: wherever this document conflicts with the real design, the existing schema, the naming and patterns already established, or a decision we made during the build, **the codebase supersedes this spec.** Do not contort working code to match a document written by someone who could not see it.

Likewise, if you have a better approach than what is described here, say so. I want your judgment. Surface the conflict or the improvement, explain the tradeoff, and let me decide before you write around it. What I do not want is silent compliance with a worse idea, or silent deviation from this document without telling me.

Specific things worth flagging if you see them: table or column names here that duplicate or contradict existing ones, a proposed table that an existing one already covers, assumptions about phase 1 behavior that turned out differently, and anything here that would violate a constraint we established during the build.

The one thing that does not bend is the reference data warning near the bottom. That is not a design preference.

## What this is, and what it is not

Beans knows things a retirement calculator has to ask you to guess: what you actually own, how it is taxed, what you actually spend, and when your mortgage is paid off. The entire value of this feature is replacing guesses with observed data, and being explicit about which is which.

**Beans describes mechanisms and shows the user's numbers against them. It never tells anyone what to do with their money.** Every projection displays the assumptions that produced it, on the same screen, not buried in settings. Every tax rule links to the authoritative IRS source. Nothing is phrased as a recommendation. Friends use this app, and a confidently wrong statement about a Roth conversion is worse than saying nothing.

Where a rule depends on the user's specific plan documents rather than on law, the app asks rather than assumes.

## Data model additions

Follow the existing conventions: household-scoped, RLS on every tenant table, encrypted columns marked below.

| Table | Purpose and notable columns |
| --- | --- |
| `retirement_profiles` | One per household. Planning horizon, `dollars_basis` fixed to `real`, timestamps. |
| `retirement_members` | Per person in the household: `birth_year`, `target_retirement_date`, `social_security_claim_age`, `social_security_annual_benefit`🔒, `life_expectancy`. Two people retire on different dates and claim on different schedules; model them separately from the start. |
| `retirement_spending_assumptions` | `category_id`, `treatment` (`continues`, `stops`, `adjusted`), `adjustment_pct`, `reviewed_at`. Scoped to the retirement profile, **not** a column on `categories`. |
| `retirement_scenarios` | Named scenario: `pre_retirement_real_return`, `post_retirement_real_return`, optional spending and retirement-date overrides, `is_default`. Seed three: pessimistic, expected, optimistic. |
| `account_tax_buckets` | `account_id`, `treatment` (`pretax`, `roth`, `after_tax`), `balance`🔒, `as_of_date`, `is_anchor`. Multiple rows per account. See below. |
| `account_contribution_routing` | `account_id`, `treatment`, `annual_amount`🔒 or percentage, `active`. Which bucket new contributions land in. |
| `projection_runs` | `run_at`, `inputs`🔒 (jsonb snapshot of every assumption), `results`🔒 (jsonb summary). Immutable. Enables tracking the plan against itself over time. |
| `opportunity_states` | `rule_key`, `tax_year`, `status` (`not_started`, `partial`, `complete`, `not_applicable`, `dismissed`), `detected_at`, `user_note`🔒. One row per rule per year. |
| `plan_features` | Per account: does the plan allow after-tax contributions, in-plan Roth conversion, in-service withdrawal, IRA roll-ins. User-answered, since none of it is discoverable. |
| `contribution_limits` | **Global reference table, not household-scoped, plaintext.** `tax_year`, `key`, `value`, `source_url`, `retrieved_at`. See the warning below. |

## Sub-account tax treatment

A single 401k commonly holds pre-tax, Roth, and after-tax non-Roth money at once. The account-level `tax_treatment` field from phase 1 is insufficient and stays as a fallback for simple accounts.

SimpleFIN reports one balance for the account and will never break this out, so the split is a user-maintained overlay:

- The user enters the breakdown as of a date. That row is an **anchor**.
- Between anchors, growth is applied proportionally across buckets and new contributions are added to the bucket named in `account_contribution_routing`.
- Whenever the user's provider shows them a fresh breakdown, they enter it as a new anchor and the model re-bases from there.

**A fixed percentage split is wrong and will drift.** My own 401k has a frozen traditional balance and an actively growing Roth balance, so the ratio changes every year on its own. The carry-forward must model that, and there should be a test asserting exactly this case: frozen bucket plus contributing bucket over ten years produces a shifting ratio, not a constant one.

This is a modeling overlay only. Net worth, the account list, and every phase 1 view continue to use the account balance and are unaffected. Only the projection and the after-tax equivalent read the buckets.

## After-tax equivalent net worth

Compute and display it. A million dollars in a traditional 401k is not a million dollars, and almost no tool says so.

- Pre-tax balances are multiplied by one minus the assumed retirement effective tax rate
- Roth balances are taken at face value
- Taxable balances are taken at face value in the first version, **with a visible note** that this ignores embedded capital gains because Beans does not have cost basis. Do not silently apply a guessed haircut.

Show it beside regular net worth with the assumption inline, never as a replacement for it.

## Setup flow

A wizard, run once and revisitable. Order matters: it goes from certain to uncertain, so the user builds confidence before hitting the parts that are guesses.

1. **Who and when.** Each household member: birth year, target retirement date.
2. **Account tax treatment.** Show every investment and cash account with its inferred treatment, let the user correct it, and let them split any account into buckets. Ask the `plan_features` questions here for employer plans.
3. **Spending review.** The important one, described below.
4. **Social Security.** Ask for the annual benefit estimate and claim age per person. **Do not attempt to compute this.** The formula requires full wage history that Beans does not have. Link to ssa.gov and ask the user to read the number off their statement.
5. **Return scenarios.** Pre-filled with three, all editable.
6. **Review and run.**

### Spending review

This replaces "assume 80% of current spending," which is folklore.

Pull trailing twelve months of expenses, exclude transfers and contributions to investment accounts, group by category, and sort descending by amount. Present each with a **pre-filled** default so the user is reviewing rather than data-entering:

- Mortgage: stops, with the payoff date already known from the amortization
- Education, childcare: stops
- Groceries, utilities, insurance, property tax: continues
- Healthcare: continues, with an explicit flag if any member retires before 65 (see below)
- Everything else: continues

The top ten categories are typically most of the spend, so allow bulk-accepting the tail. Store the answers with a `reviewed_at`, and re-prompt only when something material changes: a new category exceeding some share of spending, or the baseline drifting past a threshold. Once a year at most. **Do not nag.**

**Pre-65 healthcare** gets its own explicit line item rather than hiding inside the baseline. It is the single largest unknown for anyone retiring early, and burying it produces a cheerful and wrong projection.

## Return scenarios

Run all three scenarios simultaneously and render the projection as a band, not a line. A point estimate implies precision that does not exist.

- Separate pre-retirement and post-retirement returns, since most people de-risk on approach
- **Real returns, in today's dollars, throughout.** Nominal projections produce headline numbers that feel wonderful and mean nothing. State this on screen.
- Scenarios are editable and the user can add their own

## Projection engine

Annual timestep. Deterministic first.

Per year, in this order: contributions, growth, retirement transition for anyone crossing their date, spending withdrawal, Social Security income, required minimum distributions, tax estimate.

- Withdrawal order defaults to taxable, then pre-tax, then Roth, and is configurable
- RMDs apply to pre-tax buckets at the statutory age, which has moved twice recently and must come from the reference table, not from code
- Tax handling in the first version is an effective-rate estimate applied to pre-tax withdrawals and to the taxable portion of Social Security. Label it an estimate everywhere it appears.

Outputs: yearly balance path broken out by bucket, terminal balance or depletion year, funded ratio, and the gap in today's dollars.

**Monte Carlo is a later phase**, and it earns its place for one specific reason worth stating in the code comments: sequence-of-returns risk. A deterministic model averaging six percent and a real market averaging six percent diverge badly when the poor years land in the first five years of retirement. Prefer historical sequence bootstrapping over random normal draws.

## Opportunities engine

The most actionable part of this feature and the part with deadlines attached. A rules engine over the household's real data, answering "what should I know about this year, and have I done it."

Each rule declares: applicability, current status, the specific dollar figure, the mechanism in plain language, and a link to the authoritative source. Statuses reset on January 1. Surface open items on a dashboard with a stronger nudge as December approaches.

**Detect completion from data where possible.** A backdoor Roth is a nondeductible traditional IRA contribution followed by a conversion into a Roth IRA. If both accounts are connected those are two observable transactions. Direct IRA and HSA contributions are similarly visible. Where detection is possible, the tracker answers by looking rather than asking.

**Where detection is impossible, say so and ask.** Payroll-deducted 401k and HSA contributions never appear as transactions, so those rules need a manual year-to-date entry, ideally prompted once a quarter.

Rules to implement:

| Rule | Notes |
| --- | --- |
| `employer_match_capture` | Leaving match unclaimed is the most expensive common mistake. Needs the match formula from `plan_features`. |
| `employee_deferral_limit` | Elective deferral against the annual limit. |
| `catch_up_contributions` | Age-tiered, with additional tiers at higher ages. Rules here have changed on a staggered schedule; source everything. |
| `total_annual_additions_limit` | The combined employee, employer, and after-tax cap. This governs mega backdoor headroom. |
| `mega_backdoor_headroom` | Headroom equals the annual additions limit minus deferrals minus employer contributions. **Gated on `plan_features` confirming the plan allows both after-tax contributions and either in-plan conversion or in-service withdrawal.** Without both, the strategy does not exist for that user and the rule reports not applicable. |
| `backdoor_roth` | Contribution plus conversion detection. |
| `pro_rata_conflict` | **High value.** Any non-zero balance across traditional, SEP, and SIMPLE IRAs makes a backdoor Roth conversion partially taxable, in proportion to pre-tax balances across all such accounts. Beans can see these balances, so it can flag the conflict with the actual number. Note that 401k balances do not count toward this calculation. |
| `ira_rollin_opportunity` | The standard remedy for the above: rolling IRA balances into an employer plan that accepts roll-ins clears the pro-rata calculation. Flag the interaction explicitly, since consolidating an old 401k *into* an IRA is common advice that breaks backdoor Roth. Gated on `plan_features`. |
| `hsa_contribution` | Against the annual limit, with the catch-up tier. |
| `hsa_invested_share` | Surfaces how much of the HSA sits in cash rather than invested, since the long-horizon strategy is to invest it and pay current medical costs out of pocket. Descriptive, not prescriptive. |
| `roth_conversion_window` | Identifies low-taxable-income years between retirement and the start of Social Security or RMDs. Later phase, depends on the projection. |
| `tax_loss_harvesting` | Needs cost basis, which Beans does not have. Include as a stub that reports "not available" until holdings land in a later phase, rather than guessing. |
| `spousal_ira` | Applicability depends on filing status and earned income. |

One correction to note in the code and the copy: **there is no HSA-to-401k conversion.** The adjacent mechanisms that do exist are a once-in-a-lifetime IRA-to-HSA qualified funding distribution capped at that year's contribution limit, and IRA-to-401k roll-ins as described above. Be precise about which mechanisms are real.

## Reference data — read this carefully

Contribution limits, phaseout thresholds, catch-up tiers, and RMD ages change every year, and several provisions have phased in on staggered dates with at least one delay along the way.

**Do not write any of these numbers from model memory.** Training data is exactly wrong enough here to be dangerous, and a wrong limit produces confident, incorrect statements about real money.

Requirements:

- Every figure lives in `contribution_limits`, keyed by tax year, with `source_url` and `retrieved_at` stored alongside
- Seed it from current IRS publications at build time, and ask me to verify the seeded values before the feature ships
- The UI displays the tax year and links the source next to any limit it shows
- Missing year data produces a visible "not yet updated for this year" state, never a silently stale figure or a fallback to the prior year
- Updating for a new tax year is a data change, never a code change

## Views

1. **Retirement dashboard.** One headline stated as a range across scenarios, the projected balance band, and the assumptions visible on the same screen.
2. **Assumptions panel.** Every input badged as derived from data or entered by the user, all overridable.
3. **Scenario comparison.** Side by side. Retire at 60 versus 65, spend more versus less, markets do poorly. This is where the feature actually changes a decision.
4. **This year's opportunities.** Open items, detected status, dollar figures, sources.
5. **Tax treatment breakdown.** Balances by bucket with the after-tax equivalent.
6. **Plan history.** The projection charted against its own past runs from `projection_runs`. "A year ago the plan projected X for this date; you are actually at Y." Nothing else does this, it costs one table, and it is the most Beans-like part of the whole feature.

Both shells as usual: mobile is a tab under More, desktop is multi-pane with assumptions beside results.

## Testing

- Projection math against hand-computed fixtures, including a full year-by-year trace for one scenario
- Withdrawal ordering, including the case where one bucket depletes mid-projection
- RMD start age driven by the reference table rather than a constant
- Bucket carry-forward: the frozen-plus-contributing case described above, asserting a shifting ratio
- Pro-rata detection, including the boundary at exactly zero balance
- Reference table lookups: correct year, missing year producing the not-updated state and never a silent fallback
- Scenario band ordering: pessimistic never exceeds expected never exceeds optimistic, at every timestep
- Spending baseline: transfers and investment contributions excluded, adjustments applied correctly, mortgage dropping out at payoff

## Phases

**A — Foundation.** Tax buckets and carry-forward, after-tax equivalent net worth, setup wizard through the spending review, deterministic projection with the three-scenario band.

**B — Opportunities engine.** Reference data table, the rules above, transaction-based detection, the annual dashboard. *This does not depend on phase A and can ship first if that is more useful.* It is the part with deadlines.

**C — Monte Carlo.** Historical bootstrapping, success probability, sequence-of-returns exposure.

**D — Refinement.** Roth conversion windows, the pre-65 healthcare bridge modeled properly, plan history tracking, tax-loss harvesting once holdings exist.

## Ground rules

- No number appears without its assumption visible nearby
- No output is phrased as a recommendation
- Anything depending on plan documents is gated on an explicit user answer, never inferred
- Where Beans cannot know something, it says so plainly rather than estimating quietly
- When something in this document turns out to be wrong once you are in the code, tell me rather than working around it
