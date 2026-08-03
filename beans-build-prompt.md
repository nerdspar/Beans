# Beans — Build Prompt

Paste this into Claude Code as your opening message. Attach the Empower screenshots in the same message.

---

## What we're building

Beans is a self-hosted personal finance app. It tracks account balances over time, shows transactions, and reports cash flow for a household. It is a replacement for Empower Personal Dashboard (formerly Personal Capital).

It runs as a Docker container on a TrueNAS box. It is multi-tenant: I will use it, my wife will share a household with me, and friends will have their own separate households. Nobody can see another household's data.

I have attached screenshots of Empower. Treat them as the functional reference for what the app should do and roughly how information should be laid out. Do not copy their visual design or branding. Match the information density and the interaction model, not the pixels.

## Before you write any code

1. Read this whole document.
2. Ask me clarifying questions about anything ambiguous or anything you disagree with. I would rather answer five questions now than unwind a bad assumption later.
3. Propose the database schema and the repository structure, and wait for me to approve them.
4. Then build in the milestone order at the bottom, stopping at the end of each milestone for review.

Push back on anything in here that you think is wrong. I want your judgment, not compliance.

## Naming and voice

**Code names are plain.** The product is called Beans. That is the only themed name in the codebase. Do not invent a naming scheme for the parts. No jars, pods, pots, sprouts, or counters. Modules, tables, services, packages, and functions get plain descriptive names: `accounts`, `transactions`, `households`, `sync-worker`, `balance-history`.

**Interface copy has personality.** Beans should be pleasant to use and occasionally funny. Confine the wit to empty states, loading states, error states, and confirmations. Headers, buttons, labels, and anything a user navigates by stay plain and legible.

One hard rule: **Beans is never funny about a number moving the wrong way.** No jokes when net worth drops, when a balance goes negative, when spending exceeds income, when a card is maxed. Losing money is not a bit. In those moments the copy is calm, factual, and gets out of the way.

Put all user-facing strings in one module so the voice can be reviewed in one place rather than scattered across components.

## Stack

These are decided. Raise it with me if you think one is a mistake, but don't silently substitute.

- TypeScript everywhere, `strict: true`, no `any` without a comment explaining why
- Fastify for the API
- PostgreSQL 16, accessed via Drizzle ORM
- React 18 with Vite, as a single-page app. Not Next.js. There is no SSR requirement and the container stays lighter without it.
- Tailwind CSS with shadcn/ui components
- TanStack Query for server state
- Recharts for charts to start. Isolate all chart code behind a thin wrapper so we can swap to uPlot if time-series scrubbing gets sluggish.
- pg-boss for background jobs, so we get durable scheduling on the Postgres we already run instead of adding Redis
- Better Auth for authentication
- Vitest for tests, Playwright for a small end-to-end suite
- pnpm workspaces in a monorepo: `apps/api`, `apps/web`, `packages/shared`

Verify current versions and API surfaces of Better Auth, Drizzle, and pg-boss before using them. Several have changed significantly and your training data may be stale. Read their current docs rather than writing from memory.

## Money handling

Non-negotiable, because this is the classic silent-corruption bug:

- All monetary values are stored as **integer minor units** (cents) in `bigint` columns. Never floats, never `numeric`, never JavaScript `number` for money in transit.
- SimpleFIN returns amounts as decimal **strings**. Parse them to integer cents with string manipulation or a decimal library. Never via `parseFloat`.
- Every account carries an ISO 4217 currency code. Version 1 assumes USD throughout and refuses to aggregate across currencies, but the column exists from day one.
- Transaction dates are `date`, not `timestamptz`. A transaction posted on the 3rd is on the 3rd regardless of anyone's timezone. Sync timestamps and audit fields are `timestamptz`.
- Liabilities are stored as their natural sign and the sign convention is decided once, written down, and applied at the edges. Do not let each screen decide whether a mortgage is positive or negative.

## Data model

Core entities, roughly:

- `users` — identity, managed by Better Auth
- `households` — the tenancy boundary. Every piece of financial data hangs off a household.
- `household_members` — user to household, with a role of `owner` or `member`
- `household_invites` — signed, expiring invite tokens
- `institutions` — SimpleFIN organizations
- `connections` — one per SimpleFIN access URL, owned by a household member, with sync status and last success time
- `accounts` — belongs to a household, optionally to a connection
- `transactions` — belongs to an account, carries the SimpleFIN transaction id for deduplication
- `balance_snapshots` — one row per account per day. This table is the heart of the app; see below.
- `categories` and `category_rules` — our own categorization, because SimpleFIN provides none
- `imports` and `import_rows` — staged CSV imports, so an import can be previewed, committed, and reversed
- `sync_runs` — an audit log of every sync attempt, its outcome, and its error if any

**Account fields worth calling out:**

- `display_name`, user-editable, and `provider_name` from SimpleFIN, kept separate. Sync updates `provider_name` and must **never** overwrite a name the user has set. Institution names like "Adv Relationship Banking" are unreadable and users will rename nearly everything.
- `type`: `depository`, `credit`, `loan`, `mortgage`, `investment`, `other_asset`, `other_liability`
- `current_balance` and `available_balance`, since SimpleFIN provides both and the account detail view shows both
- `is_manual` — SimpleFIN cannot see a house, a car, a private investment, or a crypto wallet. Manual accounts have user-entered balances with an effective date and participate in net worth exactly like synced ones.
- `is_shared` — accounts default to shared with the household, but a member can mark one private. Private accounts are excluded from household rollups and are invisible to other members. My wife should not have to expose every account to use this.
- `is_closed`
- `tax_treatment`: `taxable`, `traditional`, `roth`, `hsa`, `education`, or `none`. Nothing in phase 1 uses this, but retirement planning later depends on it entirely and backfilling it across years of accounts is miserable. Ask for it when an account is added, default sensibly by account type, and let it be edited.

**Forward compatibility:** Holdings, allocation, and budgeting are deferred to later phases (see roadmap), but the schema must not preclude them. Investment accounts should be modeled such that a future `securities` and `holdings` pair can hang off them without restructuring, and categories should be able to carry a monthly target later without a migration that rewrites transaction history.

## Balance history — read this carefully

This is the part that is easy to get wrong and hard to fix later.

SimpleFIN returns a **current** balance plus a window of transactions. It does not return historical daily balances. So we construct them two ways depending on account type:

**Backward reconstruction, for cash, credit, loan, and mortgage accounts.** Balance at date T equals the current balance minus the sum of all transactions posted after T. This works because those balances only move when transactions post. It gives us real history from the first sync, as far back as the institution's transaction window reaches. Mark reconstructed snapshots with a `source` of `derived`.

**Forward snapshots, for investment accounts.** Their value moves with the market, not with transactions, so backward reconstruction is mathematically wrong. These get a daily snapshot and their history starts the day the account is connected, or the day imported history ends. Mark these `observed`.

**Imported history** from a CSV fills in the period before either of the above can reach. Mark these `imported`.

The daily snapshot job runs for every account regardless of type, so that derived, observed, and imported history converge into one uniform daily series.

Every account records the earliest date for which its history is trustworthy. The API returns that boundary with every balance series, and the UI shows it rather than implying we know things we don't. **Never draw a chart line to the left of the coverage boundary.**

## SimpleFIN integration

**Every user brings their own SimpleFIN connection.** Beans never shares one account across households. A Bridge account exposes every institution linked inside it, so sharing would put other people's bank data under one person's login and defeat the encryption entirely.

- The user pastes a **setup token**, which is a base64-encoded claim URL. We POST to it exactly once and receive a long-lived **access URL** with embedded basic auth credentials. Setup tokens are single-use, so handle claim failures carefully and never retry a claim blindly.
- The access URL is a credential. It is encrypted at rest and never returned to the client, not even partially.
- Sync calls `GET /accounts` with `start-date` and `end-date`. On first sync, pull as much history as the endpoint will give us. On subsequent syncs, overlap the window by about two weeks to catch transactions that post late or get amended.
- **The Bridge expects 24 or fewer requests per day per token.** Budget for that explicitly: a few scheduled syncs per day with jitter, a manual refresh that is rate-limited in the UI, and hard backoff on errors. Never let a retry loop burn the daily quota.
- Deduplicate on the SimpleFIN transaction id. Amounts, descriptions, and pending status can all change after first appearance, so upsert rather than insert, and keep the row's identity stable.
- Handle pending transactions explicitly. They can vanish, change amount, or convert to posted with a different id at some institutions. Decide on a policy, write it in the code, and test it. The transactions view has a dedicated pending section.
- Responses include an `errlist` of structured errors. Surface those to the user rather than swallowing them.

**Sync health is a first-class feature.** Empower shows a colored dot per account, and tapping a broken one offers to reconnect or just open the account. Beans does the same: per-connection and per-account status of healthy, stale, or error, with last successful sync time. Silent sync failure is the worst possible bug in this app, because the numbers just quietly go stale and everything still looks fine.

**Reconnecting must preserve history.** When a user re-authorizes, we replace the stored access URL on the existing connection and re-match accounts to the existing rows. Under no circumstances should reconnecting create duplicate accounts or orphan balance history.

## Importing history

Most users, including me and most of my friends, are coming from Empower with years of history. Beans needs to absorb it.

- Build a **generic CSV mapper**, not an Empower-specific parser. Upload a file, auto-detect the delimiter and header row, present a column mapping UI with a best-guess prefill, preview the parsed result, then commit. Ship an Empower preset, and structure it so Monarch, Mint, and YNAB presets are just configuration.
- Support both shapes: transaction history, and balance or net worth history if the export contains it.
- Imports are staged in `import_rows` first. The user sees what will happen before anything touches the real tables, and an import can be reversed as a unit.
- **Seam handling between imported and synced data:** imported history and the SimpleFIN window will overlap, and the same transaction will appear in both with different descriptions. Detect the overlap automatically by matching on date proximity and amount, then present the proposed matches for **manual confirmation**. Do not silently merge and do not silently duplicate. Establish a per-account cutover date once confirmed: imported data owns everything before it, synced data owns everything after.
- After import, rerun balance reconstruction so the daily series is continuous across the seam.

I have not pulled my Empower export yet, so build the functionality against the general shape and we will test with real files later. Do not hardcode assumptions about exact column names.

## Encryption

We are doing **envelope encryption**. Not zero-knowledge. The goal is that a stolen database dump or backup is useless, and that no ordinary code path ever renders another household's data. It is not a defense against me deliberately using the master key.

Design:

- Each household has a randomly generated **data encryption key** (DEK).
- The DEK is stored wrapped by a **master key** that lives in a Docker secret mounted as a file, referenced by path via environment variable. The master key never lives in Postgres and never appears inline in the compose file.
- Wrapped DEKs carry a `key_version` so we can rotate the master key without downtime.
- Encryption is AES-256-GCM, with the household id bound in as additional authenticated data so a row can't be moved between tenants.
- Unwrapped DEKs are held in a bounded in-memory LRU cache with a TTL. They are never logged, never serialized, and are excluded from error reporting.

Encrypted columns: all monetary amounts, account display and provider names, account masks, institution names, transaction descriptions, payees, and memos, plus the SimpleFIN access URL.

Plaintext columns: ids, foreign keys, dates, account type, currency code, and the boolean flags. These are needed for indexing and filtering, and they leak little.

**Because amounts are encrypted, aggregation happens in the API process after decryption, not in SQL.** Do not write `SUM()` over encrypted columns and do not be tempted to leave amounts in the clear to make that possible. A household has tens of thousands of rows at most; Node sums that in milliseconds. Cache computed aggregates keyed by household and date range.

**Put all of this behind a single `KeyProvider` interface** with `wrapDEK` and `unwrapDEK`, implemented now as `LocalMasterKeyProvider`. I may later want user-password-derived keys for true zero-knowledge. If that decision is contained to one file, it stays a possible future.

## Authentication and tenancy

- Better Auth with two methods: email plus password, and Google OAuth. Both from day one; Google is not a later addition.
- Sessions stored in Postgres. Secure, httpOnly, sameSite cookies. CSRF protection on state-changing routes. Argon2id for password hashing. Rate limiting on auth endpoints.
- Email verification and password reset are configurable and degrade gracefully when no SMTP is configured, because a self-hosted install may not have mail. Household invites work as copy-paste links so mail is never required to onboard someone.
- A user belongs to exactly one household in version 1. Design the schema so many-to-many is not a migration nightmare.
- **Two independent layers of isolation.** First, every query goes through a repository layer that requires a household context; there is no way to call a data function without one. Second, Postgres row-level security policies on every tenant table, driven by a session variable set inside the request transaction. The redundancy is deliberate.

## Platform and layout

Beans is one codebase serving two genuinely different layouts, not a desktop app that shrinks.

**Mobile is an installable PWA that behaves like a native app.** Full manifest, service worker, offline shell, standalone display mode, iOS splash and icon sets, safe-area insets respected. It should be indistinguishable from an installed app once added to the home screen.

Navigation is a fixed bottom tab bar with exactly five slots. The fifth is always **More**, which opens a sheet containing every destination that didn't fit plus settings, household, connections, import, and categories. The first four are user-configurable: the user picks which destinations appear and in what order, from a reorderable list in settings. Persist that per user, server-side, so it follows them across devices. Ship a sensible default order and make resetting to it one tap.

Everything else follows the app idiom: sheets and full-screen modals rather than new pages, swipe-back, pull-to-refresh on list views, momentum scrolling, tap targets sized for thumbs, and the bottom bar staying put while content scrolls under it.

**Desktop is a multi-pane layout that uses the width.** Persistent left sidebar for navigation rather than a hamburger. Where mobile stacks a chart above a list, desktop puts a fixed chart or summary pane beside a scrolling list, so the chart stays visible while the user moves through accounts. Detail views open in a side pane or overlay rather than replacing the current view. Denser tables with more columns, sortable headers, multi-select, and keyboard navigation throughout.

Build the two layouts as distinct shell components sharing all data logic, hooks, and formatting. Do not write one component tree littered with breakpoint conditionals; that is how both layouts end up mediocre. Pick the shell once at a breakpoint and let each be good at its own job.

## Views — phase 1

The time range control is the centerpiece and appears on nearly every screen. Presets are This month, Last month, 90 days, 1 year, YTD, Last year, and Custom. Changing the range must feel instant.

Achieve that by fetching the full daily balance series for the household once, then slicing and recomputing entirely client-side. The series is one row per account per day; even a decade across thirty accounts is trivially small. No refetch on range change, no spinner, no server round trip. Transaction lists stay server-paginated and do refetch.

### Net worth — the most important screen in the app

**This is the screen to get exactly right.** The scroll-linked behavior below is the single feature I care most about reproducing. Budget real time for it and expect to iterate.

The whole screen is **one continuous scrolling list**. There are no tabs, no separate category pages, and no tap-to-filter. Structure, top to bottom:

1. Header: the current total, the time range control, and the change over that range in green or red
2. A filled area chart
3. Assets and liabilities as a proportional bar pair
4. A single unbroken list of every account, grouped into sections: Cash, Investment, Credit card, Mortgage, Loan, Other assets

**The interaction:** as the user scrolls, the section header of whichever group they are currently in pins below the chart and becomes highlighted with that category's color. At the same moment, everything above it re-scopes to that category: the total becomes the category total, the delta becomes the category delta, and the chart redraws to that category's series in that category's color. Scrolling onward into the next section swaps header and chart together. Scrolling back to the top returns to household net worth and the assets/liabilities bars.

The app bar also collapses: at the top it reads the screen name, and once scrolled it becomes the household net worth, so the overall number is never lost while the user is inside a category.

Each category carries its own color used for both the pinned header fill and the chart fill. Household net worth, cash, investment, credit card, mortgage, and other assets each get a distinct one.

Implementation notes:

- Drive the active section from an IntersectionObserver whose root margin is pinned to the bottom edge of the chart, not from raw scroll offsets. Scroll math breaks on variable row heights and on mobile browser chrome resizing.
- Add hysteresis so fast scrolling doesn't strobe the chart through every category. The active section should change decisively, once, per crossing.
- The swap must be instant. All series are already client-side, so this is a local re-slice with zero fetching. Animate the fill color and the path morph, never a loading state.
- Honor `prefers-reduced-motion` by swapping without animation.
- Provide a non-scroll path to the same result for keyboard and screen reader users: the section headers are focusable and activating one scopes the chart directly. Announce the change via a live region.
- On desktop the chart pane is fixed beside the scrolling list, and the same active-section logic drives it. The behavior is identical; only the geometry differs.

Each account row shows institution, display name, masked number, balance, last update date, and sync status dot. Tapping a healthy row opens account details. Tapping a row with an error dot offers to reconnect or open the account anyway.

**Account details.** Editable display name, institution, mask, current balance and available balance, a per-account search box and date range, a balance chart for that account, an Add transaction button, and the transaction list grouped by date with category beneath each description.

**Transactions.** Search, date range, and All / Deposits / Expenses tabs. A pending section pinned at the top, then transactions grouped by date. A running total for the selected range shown persistently at the bottom. Add transaction, inline category editing, and bulk edit. Filters for account, category, and amount range.

**Cash flow.** Cash flow / Income / Expenses tabs. Income and expense as paired monthly bars with a net line across them and an average marker. Selecting a month lists that month's transactions below. Category breakdown for income and expenses.

**Transfers must be detectable and excludable**, or cash flow is nonsense. Match opposing amounts within a few days across household accounts, propose them as transfers, let the user confirm, and exclude confirmed transfers from income and expense totals.

**Portfolio (account level only in phase 1).** Investment accounts as a stacked area chart, plus a sortable table showing each account's one-day change in percent and dollars, its percent of the portfolio, and its balance. This needs no market data because all of it derives from daily account snapshots. Be honest in the UI that the one-day change is snapshot to snapshot and depends on the last sync.

**Household and settings.** Members and invites, which accounts each person shares, SimpleFIN connections with sync health and reconnect, manual account management, categories and rules, CSV import, and data export. Every list view gets a CSV export, matching the download affordance Empower puts in its header.

Also required: dark mode, charts readable and scrubbable on a phone, keyboard shortcuts in the transaction list, real focus management, labels on everything, and a table fallback for every chart.

## Roadmap — later phases

Do not build these now. Do keep the schema and the API shaped so they don't require a rewrite.

**Phase 2 — Holdings and Allocation.** Security-level positions with share counts and cost basis, per-security daily price history, and asset-class classification. This needs a market data provider and a classification source beyond SimpleFIN, whose holdings coverage is thin and inconsistent. Worth noting that Empower itself leaves 27.79% of my portfolio Unclassified, so the bar for "good enough" is lower than it looks.

**Phase 3 — Benchmark comparison.** Daily time-weighted portfolio returns charted against a selectable benchmark. This is real financial engineering, not a chart component, and it depends on phase 2 data.

**Phase 4 — Budgeting.** Monthly targets per category, actual against target, this month versus last month. I personally don't use it, but other people will.

**Phase 5 — Retirement tracking and projection.** Beans already knows balances, contribution flows, and spending, which is most of what a retirement projection needs. Add explicit assumptions the user controls (target retirement age, expected return, inflation, expected Social Security, desired retirement spending), then project balances forward by tax treatment and show whether the plan holds. Deterministic projection first, Monte Carlo with a success probability after that. Depends on `tax_treatment` being populated and on cash flow being clean enough to derive real contribution and spending rates, which is why both are handled properly in phase 1.

One framing constraint that matters: **Beans shows projections and the assumptions behind them. It does not give financial advice.** Every number is traceable to an assumption the user can see and change, the assumptions are visible on the same screen as the result rather than buried in settings, and the app never tells anyone what to do with their money. Friends will use this, and a confident-sounding retirement number built on invisible defaults is worse than no number at all.

**Phase 6 — Tax profile.** A small set of numbers from the user's most recent return: filing status, AGI, taxable income, total tax, total withholding, standard versus itemized, and capital loss carryover. That handful of fields unlocks real things — effective and marginal rate for the retirement projection, a withholding check against the current year's pay, and contribution eligibility limits that phase out by AGI.

**Enter these by hand as a form first.** Optional PDF extraction can come later, and if it does, it works like this: parse, show the extracted values for confirmation, store only the confirmed numbers, and **discard the document immediately**. Beans never retains a tax return, and never stores Social Security numbers, dependent information, employer details, or addresses. A stored 1040 is the most sensitive object a personal finance app could hold, and the useful part of it is about eight numbers.

## Reference material

The repo contains a `screenshots/` folder of Empower captures with a `README.md` indexing what each one shows. Read that README before building any view. The six net worth screenshots are the same screen at successive scroll positions and together document the scroll-linked behavior described above.

## Deployment

- Multi-stage Dockerfile producing one image that serves the API and the built static frontend
- `docker-compose.yml` with the app, Postgres 16, healthchecks, named volumes, and the master key as a Docker secret
- Migrations run on startup, idempotently
- Config entirely through environment variables, documented in `.env.example` with every variable explained
- A `/health` endpoint that checks database connectivity and reports sync worker status
- Structured JSON logging with a redaction list, so amounts, names, tokens, and keys never reach the logs
- A backup script that dumps Postgres, and documentation stating clearly that a dump is worthless without the master key, and that the master key must be backed up separately

## Testing

I want to be able to run the suite at any point and trust that the math is intact. This is not a checkbox at the end.

**Must have real coverage:**

- **Money parsing.** Decimal strings to integer cents, including negatives, thousands separators, missing decimals, and more than two decimal places. Property-based tests over generated inputs.
- **Balance reconstruction.** Given a known current balance and a known transaction set, the derived series must be exact. Test the boundary date, out-of-order postings, amended transactions, and accounts with zero transactions in the window. Include a fixture where reconstruction and later observed snapshots must agree at the seam.
- **Import seam.** Imported history plus synced history must produce one continuous series with no double counting and no gap at the cutover date.
- **Transfer detection.** Real transfer pairs matched, near-miss coincidences not matched, and confirmed transfers correctly excluded from cash flow totals.
- **Aggregation.** Net worth, group subtotals, and cash flow totals against hand-computed fixtures. Assets minus liabilities must equal net worth in every fixture.
- **Encryption.** Round trip for every encrypted column type, AAD binding rejecting a row moved between households, and key rotation preserving readability of old rows.
- **Tenant isolation.** Deliberate attempts to read another household's data through the repository layer and through raw SQL under RLS, asserted to fail. **These are the most important tests in the repo.**
- **Sync idempotency.** Running the same sync payload twice changes nothing. A pending transaction becoming posted updates in place rather than duplicating. Reconnecting a connection does not duplicate accounts or orphan history.

**Practices:** unit tests run against no database, integration tests run against a real Postgres in Docker rather than a mock or SQLite. Deterministic fixtures with fixed dates, never `new Date()` in a test. A dedicated `pnpm test:math` script covering parsing, reconstruction, aggregation, and transfers, so I can run the critical path in seconds. Write the tests alongside each feature, not at the end of the milestone.

## Milestones

Build in this order. Stop at the end of each for my review.

1. Repo scaffold, Docker setup, schema, migrations, encryption layer with round-trip and rotation tests
2. Auth with email/password and Google, households, invites, RLS policies, cross-tenant tests
3. SimpleFIN connection flow, account import, transaction sync, quota-aware scheduling, sync health and reconnect
4. Balance history: backward reconstruction, daily snapshot job, coverage boundaries, the full math suite
5. CSV import with mapper, staging, seam detection and confirmation
6. Frontend shells: mobile PWA shell with configurable bottom tabs, desktop multi-pane shell, shared data layer. **Before starting this milestone, stop and ask me for access to my AfterTaste repo.** It already implements the mobile shell pattern I want — five bottom tabs with More in the fifth slot and user-reorderable tabs — and matching it is faster and better than reinventing it. Do not build the shell from scratch without asking first.
7. Net worth view with the scroll-linked category behavior and time range control. Treat this as its own milestone and expect to iterate on the feel.
8. Account details, transactions view, categorization and rules
9. Cash flow view, transfer detection and confirmation
10. Portfolio at account level, manual accounts, household and settings, exports
11. Polish, accessibility, error states, empty states, voice pass over all copy

## Ground rules

- Write tests as you go, not at the end.
- Keep `ARCHITECTURE.md` current with decisions and the reasoning behind them, and maintain a `CLAUDE.md` with conventions for future sessions.
- No feature flags for things nobody asked for. No abstraction layers with a single implementation, other than `KeyProvider`, which exists for a stated reason.
- When something in this document turns out to be wrong once you're in the code, tell me rather than working around it.
