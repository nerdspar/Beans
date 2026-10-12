# Beans — Architecture

Decisions and the reasoning behind them. If you are a future session picking this up, read this
before changing anything structural. Several decisions here look wrong until you know why they were
made; the reasoning is recorded specifically so they don't get "fixed."

Last updated: 2026-08-03 (milestone 2)

---

## 1. What Beans is

A self-hosted, multi-tenant personal finance app replacing Empower Personal Dashboard. It tracks
account balances over time, shows transactions, and reports cash flow for a household. It runs as a
Docker container on TrueNAS at `https://beans.nerdspar.com`.

Tenancy boundary is the **household**. Every piece of financial data hangs off one. No ordinary code
path can render another household's data.

---

## 2. Naming

The product is called Beans. **That is the only themed name in the codebase.** Modules, tables,
services and functions get plain descriptive names: `accounts`, `transactions`, `households`,
`sync-worker`, `balance-history`. No jars, pods, pots, sprouts, or counters.

Interface copy has personality, confined to empty / loading / error / confirmation states. All
user-facing strings live in one module (`packages/shared/src/copy/`) so the voice is reviewable in
one place.

**Hard rule: Beans is never funny about a number moving the wrong way.** No jokes when net worth
drops, a balance goes negative, spending exceeds income, or a card is maxed. In those moments copy is
calm, factual, and gets out of the way. This is enforced by convention and by review of the copy
module, not by a lint rule — but it is not negotiable.

---

## 3. Money

**Storage: integer minor units (cents) as `bigint` in the domain, `bytea` on disk.**

- Never floats. Never `numeric`. Never JavaScript `number` for money in transit.
- SimpleFIN returns amounts as decimal **strings**. They are parsed to integer cents by string
  manipulation, never `parseFloat`.
- Every account carries an ISO 4217 currency code. v1 assumes USD and **refuses to aggregate across
  currencies**, but the column exists from day one.
- Transaction dates are `date`, not `timestamptz`. A transaction posted on the 3rd is on the 3rd
  regardless of anyone's timezone. Sync timestamps and audit fields are `timestamptz`.

### 3.1 bigint vs bytea — the reconciliation

Amounts are encrypted (§5), so the physical column is `bytea` ciphertext. `bigint` cents is the
**domain / TypeScript type**; the crypto codec serializes the bigint to bytes and back.

The consequence is larger than it first appears: **SQL cannot sum, sort, or range-filter on any
monetary column.** This is not a limitation to work around — it is what drives the client-side
working set in §7. Do not add plaintext "shadow" amount columns to make SQL math possible. Do not add
blind indexes or order-preserving encryption; OPE on amounts leaks essentially the entire
distribution, which is most of what we are protecting.

### 3.2 Sign convention — decided once, applied at the edges

**Every amount is stored signed so that it adds directly to net worth.**

| Thing             | Stored as |
| ----------------- | --------- |
| Asset balance     | positive  |
| Liability balance | negative  |
| Income            | positive  |
| Spending          | negative  |

So net worth is a plain sum. A mortgage with $824,871.23 owed is stored as `-82487123n`.

Normalization to this convention happens **once, at the SimpleFIN ingest edge**. No screen, query, or
component ever decides a sign.

**Assets and liabilities are classified by `accounts.type`, never by sign.** An overdrawn checking
account has a negative balance and is still a cash asset. Sign is only sign. Classifying by sign
would silently move an overdrawn account into the liabilities bar.

### 3.3 Credit card ingest is the highest-risk code in the app

SimpleFIN institutions are inconsistent about whether a card balance arrives as a negative number or
as a positive magnitude of what is owed. Getting it backwards puts net worth off by **twice** the
card balance, in a plausible-looking direction, with no error raised anywhere.

Defenses, all three required:

1. **Per-type normalization rules** in one module, with the rule that fired recorded on the sync run.
2. **Sign sanity checks** that flag rather than silently accept:

   | Type                                      | Expected    | On violation                                                |
   | ----------------------------------------- | ----------- | ----------------------------------------------------------- |
   | `mortgage`, `loan`                        | ≤ 0         | Hard flag — near-certainly a flipped sign                   |
   | `credit`                                  | ≤ 0         | Flag (real credit balances from refunds exist but are rare) |
   | `depository`, `investment`, `other_asset` | ≥ 0 typical | Flag if negative; overdrafts are legitimate                 |

3. **Connection-time confirmation.** Discovered accounts are shown with their interpreted balances
   and nothing is committed until the user confirms. Flagged accounts sort to the top with the raw
   provider value shown beside our interpretation. This catches a flip in the one moment a human is
   already reading the numbers.

Post-confirmation, a sign flip relative to established history **holds the balance update** rather
than applying it, and surfaces on connection health. Silently doubling a net-worth error is worse
than briefly stale data.

---

## 4. Balance history

SimpleFIN returns a **current** balance plus a window of transactions. It does not return historical
daily balances. We construct them three ways and converge them into one uniform daily series.

| Method                                                                                            | Applies to                   | `source`   |
| ------------------------------------------------------------------------------------------------- | ---------------------------- | ---------- |
| **Backward reconstruction** — balance at T = current balance − sum of transactions posted after T | cash, credit, loan, mortgage | `derived`  |
| **Forward snapshots** — daily observation, history starts at connection                           | investment                   | `observed` |
| **Imported** — CSV fills the period before either can reach                                       | any                          | `imported` |
| **Carried** — last known balance held flat while a sync is broken                                 | any                          | `carried`  |

Backward reconstruction works for the first four types because those balances only move when
transactions post. It is **mathematically wrong for investment accounts**, whose value moves with the
market, so they get forward snapshots instead.

### 4.1 Authority: `current_balance` is the input, snapshots are derived output

`balance_snapshots` is a **pure function** of
`(current_balance, balance_as_of, transactions, manual_balance_updates, imported history)`.

It is a materialization. It is never edited independently. It is always recomputable from scratch.
**If the two ever disagree, `current_balance` wins and the series is recomputed** — divergence is a
bug in reconstruction, never a data conflict to merge.

Invariant, tested: **for every account, `snapshot(balance_as_of) == current_balance` exactly.**

`available_balance` deliberately has **no snapshot equivalent**. It is a right-now field shown only on
account detail, never charted. Do not "fix" this asymmetry.

### 4.2 Reconstruction only rewrites forward from the affected date

When a late transaction posts dated in the past, only snapshots **from that transaction's date
forward** change. Dates before it are provably unchanged: the shift in `current_balance` and the
shift in the transaction sum cancel exactly. This bounds delta-sync volume (§7) to how far back late
postings reach — days to weeks, not the whole series.

### 4.2a Trusting imported history

`households.trust_imported_history` lets a household extend how far back a chart is drawn using
imported transactions. **Off by default, and the default is the honest one** — see §4.3 for why the
boundary exists at all.

The switch exists because the alternative is worse for a real household. Reconstruction before the
sync window is only sound if the CSV is complete, and *only the household can know that*. Beans
guessing on their behalf means either refusing history somebody has good reason to trust, or drawing
one they have good reason to doubt.

**It widens the rebuild window; it never rewrites the boundary.** `coverage_start_date` keeps meaning
"what the provider vouches for", and the effective start is `min(declared, earliest transaction)`
computed at rebuild time. So turning it off and rebuilding restores the previous chart exactly, which
is the property that makes it safe to try — and it is asserted by an integration test that compares
the series before and after a round trip rather than merely checking it got shorter.

That test caught a real defect: `writeSnapshots` only ever upserts, deliberately, so that imported
history survives a resync (§4.1). A range that gets **narrower** therefore left its old tail behind
and the chart did not move. The rebuild now deletes `derived` snapshots earlier than the series it
just wrote — scoped to that source, because imported and observed rows are precisely what the
upsert-only rule protects.

**The client clips to the data, not to the declared date.** `deriveWorkingSet` used to start each
account's series at `max(window, coverage_start_date)`, which discarded exactly the days this
setting exists to produce — after the server had written them and sent them over the wire. The
symptom was the setting appearing to do nothing at all for every synced account, while working
perfectly for accounts whose declared coverage happened to be old already. The boundary is now the
earlier of the declared date and the oldest snapshot actually held, which is safe because a snapshot
exists only where the rebuild wrote one, and the rebuild is what enforces §4.3 in the first place.

Offered both at import time and in settings. Neither alone is enough: at import you are holding the
file and know what is in it, but you cannot yet see what it draws; in settings you can see the
result, but only after the moment you were best placed to judge the source.

### 4.3 Coverage boundary

Every account records `coverage_start_date`, the earliest date for which its history is trustworthy.
The API returns it with every balance series and the UI shows it.

**Never draw a chart line to the left of the coverage boundary.** Implying we know things we don't is
the worst thing this app can do with a chart.

Stale accounts carry forward flat (`carried`) so household net worth stays summable when one
account's sync is broken — but the UI says so explicitly ("2 accounts stale, carried forward since
7/28") rather than presenting it as observed fact.

### 4.4 What the provider said is currently thrown away

**Open, and the most consequential unresolved thing in the app.**

For a reconstructable account — cash, credit, loan, mortgage — `rebuildAccountHistory` writes an
entirely `derived` series. The balance the institution reported is used as the anchor and then
discarded. Nothing writes an `observed` snapshot for these accounts at all; the only such insert in
the codebase is the zero after a closed account's closing date.

That means Beans keeps what it computed and not what it was told, and the two can disagree. §3.3
names the failure that makes this matter: an institution reporting balances and transactions in
opposite sign conventions produces a smooth, plausible, steadily wrong chart.

**The check that was supposed to catch it cannot.** `checkReconstruction` compares the last point of
the derived series to the balance it was derived *from*. `reconstructBackward` deliberately excludes
later-dated transactions to preserve "the invariant that the last entry equals the observed balance
exactly" — so the check asserts an invariant of the algorithm. It can only fail if reconstruction is
buggy. Its test asserted `consistent === true` under a name claiming the opposite, and the manual
testing backlog counted that as coverage for the highest-risk failure in the app.

`analyseDrift` (`packages/shared/src/balance-history/drift.ts`) is the real check: between two
independent readings, the transactions either explain the change or they do not, and inverted signs
produce drift of exactly twice the net movement in the same direction — a signature rather than a
smell, which is why it can name the cause instead of reporting a large number.

It reports on the sync run rather than raising. Three periods of same-direction drift is strong
evidence and not proof, and the balances remain the provider's own figures either way. One period is
deliberately silent: a provider missing a transaction or a pending row settling differently goes
both ways, and a check that fires on ordinary noise is one nobody reads.

**It needs several readings before it can say anything**, so a newly connected account is unprotected
for its first weeks — which is exactly when a sign convention error is introduced. It reduces the
manual check in the testing backlog rather than replacing it.

**Built as `balance_readings`, a separate table rather than a policy for which value wins.** `balance_snapshots` has
`unique(account_id, as_of_date)` — one row per account per day — which is what forces an observed
value and a derived value to compete for the same slot, and what made this look like a decision
about what the chart should draw. It is not. A log of provider readings, written once per sync
and read by nothing that draws, keeps both facts without either displacing the other: the chart
continues to show reconstruction, and the disagreement becomes visible.

Written from `updateBalance` in the sync path **and nowhere else**. A rebuild triggered by an edit —
a sign flip, a manual correction — also has a balance in hand, and recording that would turn the
table from what the provider said into what Beans last thought, which is exactly what it exists to
be independent of.

The readings are also their own export (§11.2). They are the only primary figures in the file:
everything in the daily balances for a reconstructable account is computed from them.

Reconstruction should stay authoritative for the chart (§4.1). A provider's balance is frequently
stale — the portfolio's dated figures exist because of exactly that — so pinning history to reported
values would replace a smooth wrong line with a jagged one, and lose the property that a
late-posting transaction retroactively corrects the days it belongs to.

---

## 5. Encryption

**Envelope encryption. Not zero-knowledge.** The goal is that a stolen database dump or backup is
useless, and that no ordinary code path renders another household's data. It is explicitly _not_ a
defense against the operator deliberately using the master key.

- Each household has a randomly generated **data encryption key (DEK)**.
- The DEK is stored wrapped by a **master key** held in a Docker secret mounted as a file, referenced
  by path via environment variable. The master key never lives in Postgres and never appears inline
  in the compose file.
- Wrapped DEKs carry a `key_version` so the master key can rotate without downtime.
- **AES-256-GCM**, with the **household id bound in as additional authenticated data (AAD)** so a row
  cannot be moved between tenants.
- Unwrapped DEKs live in a bounded in-memory LRU cache with a TTL. Never logged, never serialized,
  excluded from error reporting.

**Encrypted columns:** all monetary amounts, account display and provider names, account masks,
institution names, transaction descriptions, payees, memos, category rule match text and amounts, and
the SimpleFIN access URL.

**Plaintext columns:** ids, foreign keys, dates, account type, currency code, boolean flags. Needed
for indexing and filtering; they leak little.

### 5.1 KeyProvider

All key handling sits behind a single `KeyProvider` interface with `wrapDEK` / `unwrapDEK`,
implemented now as `LocalMasterKeyProvider`.

This is the **one permitted single-implementation abstraction** in the codebase, and it exists for a
stated reason: user-password-derived keys (true zero-knowledge) may be wanted later. Containing that
decision to one file keeps it a possible future. Do not add other speculative interfaces.

### 5.2 Aggregation happens in application code

Because amounts are encrypted, `SUM()` over them is impossible. Aggregation happens after decryption.
A household has tens of thousands of rows at most; this is milliseconds. See §7 for where it happens.

---

## 6. Tenancy and isolation

**Two independent layers, deliberately redundant.**

1. **Repository layer.** Every query goes through a repository that _requires_ a household context.
   There is no way to call a data function without one.
2. **Postgres row-level security.** RLS policies on every tenant table, driven by session variables
   set inside the request transaction:
   - `app.current_household` → household-scoped tables
   - `app.current_user_id` → `user_preferences`

The application connects as a **non-superuser, non-`BYPASSRLS` role**. This matters: RLS is silently
bypassed for superusers and table owners, so getting the role wrong disables layer 2 without any
visible symptom.

**Three things are required for RLS to actually be enforced. Missing any one is silent:**

1. **Policies exist** — generated from the schema (`householdIsolationPolicy`), migration `0000`.
2. **`FORCE ROW LEVEL SECURITY`** — migration `0002`. Postgres exempts a table's _owner_ from RLS by
   default, and migrations create the tables, so whichever role runs them owns them. Without FORCE,
   every policy is skipped for exactly the role the app uses. No error, no warning.
3. **A non-superuser, non-`BYPASSRLS` role** — created by `docker/initdb/01-init.sh` with explicit
   `NOSUPERUSER NOBYPASSRLS`. Superusers bypass RLS even with FORCE.

**A fourth, discovered by the integration tests:** the policy must read
`nullif(current_setting('app.current_household', true), '')::uuid`, not `current_setting(...)::uuid`.

Once a custom GUC has been set on a connection, ending the transaction reverts it to the **empty
string** rather than unsetting it. On a pooled connection that previously served a request,
`current_setting` therefore returns `''`, and `''::uuid` raises `invalid input syntax for type uuid`
instead of comparing. That does not leak data — but it fails with a 500 rather than an empty result,
and a fail-closed guarantee resting on an exception is a far weaker guarantee than one resting on a
comparison. Fixed in migration `0003`.

The tenant isolation tests assert all three, including that `relforcerowsecurity` is set on every
household-scoped table. A new tenant table needs its policy, its FORCE, and its `updated_at` trigger
added together, in the same migration.

`auth_*` tables are exempt from household RLS — identity is cross-household by nature.

**Cross-tenant isolation tests are the most important tests in the repo.** They attempt to read
another household's data both through the repository layer and through raw SQL under RLS, and assert
failure.

### 6.1 Better Auth table naming

Better Auth's default tables (`user`, `session`, `account`, `verification`) are prefixed **`auth_`**
→ `auth_user`, `auth_session`, `auth_account`, `auth_verification`.

Reason: Better Auth's `account` means "OAuth provider link," which would collide conceptually and
namespace-wise with our financial `accounts`. The prefix keeps the two worlds unambiguous.

### 6.2 Bootstrap policies — reaching the first row

Two operations have a genuine chicken-and-egg problem: they need to read a household-scoped table
in order to discover which household to scope to. Each is solved by a deliberately narrow,
**select-only** permissive policy keyed to a session variable.

| Policy                              | Predicate                            | Why it is safe                                                                                    |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `household_members_self_select`     | `user_id = app.current_user_id`      | Matches exactly the caller's own membership row. Nothing else becomes visible.                    |
| `household_invites_by_token_select` | `token_hash = app.invite_token_hash` | The only way to match is to already hold the token — which _is_ the capability the invite grants. |

Both are `for: 'select'` only, so they widen reads and never writes. Postgres ORs permissive
policies together, so each adds precisely one reachable row to what the household policy already
allows.

**`SELECT ... FOR UPDATE` requires the row to satisfy the UPDATE policy, not just SELECT.** This
bit during implementation: locking the invite row during the token lookup silently found nothing,
because the token policy is select-only. Accepting an invite therefore reads unlocked first,
sets `app.current_household` from the result, and only then re-reads `FOR UPDATE` — at which point
the household policy applies and the lock works. The failure mode was an invisible row rather than
an error, which is exactly the kind of thing that reaches production.

### 6.3 One household per user in v1

`household_members` is a pure join table with a `unique(user_id)` constraint enforcing one household
in v1. Removing that single constraint is the entire migration to many-to-many — no restructuring.

### 6.4 Private accounts — visibility inside a household

`accounts.is_shared` shipped as a column and a promise: the schema said private accounts were
"excluded from household rollups and invisible to other members", and nothing enforced it. It could
not have. There was no owner column, so "invisible to other members" had no referent — the boolean
was read by nobody.

Accounts now carry `owner_user_id`, and the policy is household **and** visible:

```sql
household_id = nullif(current_setting('app.current_household', true), '')::uuid
and (is_shared or owner_user_id = nullif(current_setting('app.current_user_id', true), ''))
```

**The household clause is untouched and ANDed, and that ordering is the whole safety argument.**
Nothing in the visibility half can widen cross-tenant access; it can only narrow within one tenant.
There is an isolation test asserting a private account is still invisible from another household,
sitting beside the cross-tenant tests rather than in a file of its own, for that reason.

It fails closed. Private with no owner resolves to visible-to-nobody rather than
visible-to-everybody — including for the person who hid it, which is recoverable. The opposite
default shows somebody's separate finances to the person they hid them from, which is not.

**Child tables stay isolated by household alone, deliberately.** A per-row visibility subquery on a
table with a hundred thousand transactions in it is a real cost, and every read path already
inner-joins `accounts` — so account visibility decides what comes back for free. That is a property
worth knowing about rather than rediscovering: a new query that reads transactions *without* joining
accounts leaks a private account's rows. Transfer detection did exactly that until it was fixed; a
proposal names two transactions, and one from a hidden account discloses both its existence and an
amount.

---

## 7. Data sync architecture — client-side working set

**This supersedes the spec line "Transaction lists stay server-paginated and do refetch."** That line
was written before the encryption consequences were fully worked through. Do not restore it.

### 7.1 Why

Because amounts and descriptions are ciphertext (§3.1), Postgres cannot search, sort, or range-filter
them. Something must hold plaintext to do that work. The options were server memory or the browser.
**The browser wins:**

- Server memory stays flat regardless of how many households are active. A per-household server cache
  means every active household's decrypted finances resident in RAM simultaneously — a far larger
  blast radius in a heap dump than one household per request.
- Filtering, sorting and search become instant with no round trip. This is the same reason the
  balance series is already client-side; two mechanisms doing one job is worse than one.
- The mobile PWA gets offline support nearly free.

### 7.2 Shape

- Endpoints are **"everything changed since cursor X"**, not paginated queries.
- Cache is **IndexedDB**, with delta sync on open.
- **Default window is ~2 years**, with older data fetched on demand when the user extends the range
  past it. Eager-loading a decade across fifteen accounts is a ~60MB initial payload — fine on
  desktop, awful on cellular.

  The on-demand half went unbuilt for a while, and the symptom was not an error: a custom range
  reaching back to 2019 simply drew nothing before the window and said nothing about why. The data
  was on the server; it had never been asked for. `useHistoryBackfill` now watches the resolved
  range and fetches when it starts earlier than the cached `coverageFrom`.

  Two rules make that safe. A backfill sends `from` **with no cursor** — a delta answers "what
  changed since X", and nothing about a 2019 balance changed; it was never sent. And it must **not
  write the cursor**, or anything committed between the last real sync and the backfill would fall
  before the new one and never be sent again. `coverageFrom` only ever moves earlier, so a later
  ordinary sync cannot make the cache claim to hold less than it does.
- **One cache, not two.** IndexedDB is the only _persistent_ cache. TanStack Query is the in-memory
  view over it — no persister plugin layered on top, no second TTL. Two caching layers with
  independent TTLs is where staleness bugs live.

### 7.3 Cursor and deletions

- `updated_at timestamptz` on every client-cached table, maintained by a **database trigger**, not
  application code, so no write path can forget it. Indexed `(household_id, updated_at)`.
  This matters most for `balance_snapshots`: reconstruction rewrites history when a late transaction
  posts, so old rows change without anything being inserted.
- Deletions are the other half. A `deletions` tombstone log (`household_id`, `entity_type`,
  `entity_id`, `deleted_at`) covers hard deletes — import reversal, account removal — which otherwise
  leave the client holding rows the server no longer has, with no way to learn that.
- The cursor is a timestamptz replayed with a **small overlap** rather than a strict `>`; the client
  upserts by id, so replay is idempotent. Avoids clock-skew and same-timestamp edges without needing
  a monotonic sequence.
- **Tombstone retention is 90 days.** If a client's cursor predates the floor, the server cannot prove
  what was deleted and must respond **"full resync required"** rather than returning a silently
  incomplete delta.

### 7.4 The cost, stated plainly

IndexedDB is **plaintext at rest in the browser profile**. Envelope encryption protects a stolen
database dump, which is the stated goal — but a decrypted household working set now also sits on
every device the user has logged in from. Mitigations: clear the store on logout and on session
expiry, and document it. This moves exposure rather than eliminating it, and that tradeoff was made
knowingly.

### 7.4a Clearing, as built

`clearWorkingSet` is called on **sign-out**, on **session expiry** (a working-set request answering
401 while the tab is open), and when the server demands a full resync.

Sign-out then does a **full page reload**. Emptying the query cache and letting the session refetch
should be enough, and it is the tidier thing to write — but it leaves what survives to React Query's
lifecycle rules, and the first implementation lost that argument: its cleanup lived in `onSettled`,
the sheet that owned the mutation unmounted, React Query skipped the callback, and the previous
user's balances stayed on screen after a successful sign-out. IndexedDB had been cleared; the
in-memory copy had not. The reload is not a workaround for that bug — it is the stronger guarantee,
and for an app whose storage argument is "the plaintext leaves when the session does", the blunt
instrument is the correct one.

### 7.5 As built

`GET /api/working-set` is the only endpoint that returns financial data. Repository in
`apps/api/src/repositories/working-set.ts`, client store in `apps/web/src/working-set/`.

- **Unconfirmed accounts are excluded at the query**, not in the UI. An unconfirmed account has not
  had its balance sign checked by a human (§3.3), so there is no path by which one reaches a screen.
- **The cursor is read before the reads and rewound five seconds.** Taken afterwards, a row committed
  while the reads run would fall before the new cursor and never be sent again. Re-sending is free —
  the client upserts by id — and skipping is permanent.
- **Ordering carries an `id` tiebreaker.** Accounts written in one transaction share a `created_at`
  to the microsecond, and without it Postgres may return them in a different order each time, which
  reaches the user as rows that shuffle between refreshes.
- **Section order is canonical**, from `NET_WORTH_SECTIONS`, not the order accounts arrived in.
- The client parses money to `bigint` cents **once, at ingest**, and stores it that way — IndexedDB
  holds bigint natively, so no component ever sees a money string it might `parseFloat`.
- A delta applies in **one IndexedDB transaction across all stores including the cursor**. A partial
  apply that still advanced the cursor would skip the rest of that batch permanently.
- Deleting an account **cascades on the client by hand**. The server logs one tombstone for the
  account rather than thousands for its rows, so a client that deleted only the account row would
  keep every balance beneath it forever and silently inflate net worth.

Measured on the seeded household: first load ~745KB for 10 accounts and 6,329 daily snapshots, and
**154 bytes** for a subsequent no-op delta.

---

## 8. Categories

- Household-scoped, seeded with a sensible default set each household can edit.
- **`slug`** — stable, unique per household, **immutable for system categories**. Rules and CSV import
  presets reference the slug, never the display label, so renaming "Groceries" to "Food" breaks
  nothing.
- **`name`** — display label, freely renameable.
- **`kind`** — `income` | `expense` | `transfer`.
- **Two levels maximum.** A category with a parent may not itself be a parent.

Uniqueness is `unique(household_id, parent_id, name)` with **`NULLS NOT DISTINCT`** (PG16). Without
that clause Postgres treats NULLs as distinct and two top-level categories named "Other" would both
be permitted. Scoping by parent is what lets "Other" exist under both Income and Expenses.

The two-level cap **cannot be expressed as a `CHECK`** (it requires looking at another row), so it is
enforced by a trigger _and_ a repository invariant, with a test that nests three deep and asserts
failure. Belt and braces, because unconstrained self-reference gets ambiguous once real data exists
and every UI then has to handle arbitrary depth.

---

### 8.1 Rules run on what arrives, not only when pressed

Rules applied when created, when edited, and when somebody pressed Apply — and never again. Every
transaction from every subsequent sync landed uncategorized and stayed that way, which is the
opposite of what recording a decision is for; the categorize sheet says as much in its own copy.

They now run at the end of a sync and after an import commits. Import is where it matters most: a
decade of history arrives at once, entirely uncategorized, while every rule already written applies
to none of it.

Safe unattended because `applyRules` only touches transactions with no category. It cannot overwrite
an answer a person gave, so it adds work nobody has to review rather than changing anything already
decided. Non-fatal after a sync, like transfer detection — balances are already written, and the
worst case is categories arriving one sync late. **Fatal inside an import**, and not by choice:
Postgres aborts a transaction on the first failed statement, so catching there would buy nothing.

---

## 9. Transfers

A confirmed transfer is a **linked pair** in `transfer_matches` (from-transaction ↔ to-transaction,
status `proposed` | `confirmed` | `rejected`). A transfer to an account Beans doesn't track stays an
ordinary transaction with the built-in **Transfers** category and forms no pair.

- **`rejected` is sticky**, keyed on a canonical `pair_key`, so the matcher cannot re-propose a
  dismissed pair after every sync. Otherwise the user learns to ignore the prompt.
- Partial unique indexes on `from_transaction_id` and `to_transaction_id` `WHERE status='confirmed'`,
  so a transaction belongs to at most one confirmed pair.
- Those two indexes are _sufficient_, not merely convenient: `from` is always the outflow (negative)
  and `to` the inflow (positive), enforced at insert. A transaction has one sign, so it can never be
  `from` in one pair and `to` in another. The cross case is impossible by construction.

**Exclusion is written once, in one function** in `packages/shared`: a transaction is excluded from
cash flow if it is **in a confirmed pair OR its category kind is `transfer`**. Cash flow, Phase 4
budgeting, and every export call that one function. Do not reimplement it per screen.

Invariant, tested: **every confirmed transfer pair sums to exactly zero.**

Detection also runs after an import commits, not only after a sync. A file of a household's own
history is full of transfers — every card payment, every move to savings — and none were proposed
until somebody pressed the button on the cash flow screen. Nobody presses a button to check for a
problem they cannot see.

The matcher buckets candidate inflows by amount rather than scanning every inflow for every outflow.
The old shape was fine on a few hundred transactions and tens of millions of comparisons on an
imported decade — and it is the reason detection only looks back 120 days. That window is unchanged
and is now a cheap thing to revisit.

### 9.1 Mortgage payments are NOT transfers — do not "improve" this

A payment to a mortgage servicer leaves checking as one amount, but the mortgage balance drops by
only the **principal** portion. The remainder is interest, which is a real expense.

Because the two amounts don't match, the auto-matcher correctly declines to pair them. **This is
load-bearing, not accidental.** The obvious "improvement" of loosening amount tolerance would break
it and start silently erasing interest expense from cash flow.

**Do not fuzzy-match amounts across a liability boundary.** Principal-versus-interest splitting is out
of scope for now.

Credit card payments are the highest-volume transfer case and get their own fixture set.

---

## 10. SimpleFIN

**Every user brings their own connection.** Beans never shares one across households — a Bridge
account exposes every institution linked inside it, so sharing would put other people's bank data
under one person's login and defeat the encryption entirely.

- The user pastes a **setup token** (base64-encoded claim URL). We POST to it **exactly once** and
  receive a long-lived **access URL** with embedded basic auth. Setup tokens are single-use, so claim
  failures are handled carefully and a claim is **never retried blindly**.
- The access URL is a credential: encrypted at rest, never returned to the client, not even partially.
- Sync calls `GET /accounts` with `start-date` / `end-date`. First sync pulls as much history as the
  endpoint gives. Later syncs **overlap by ~2 weeks** to catch late-posting and amended transactions.
- **Quota: 24 or fewer requests per day per token.** Budgeted explicitly — a few scheduled syncs per
  day with jitter, a UI-rate-limited manual refresh, and hard backoff on errors. A retry loop must
  never burn the daily quota.
- **Deduplicate on the SimpleFIN transaction id.** Amounts, descriptions and pending status all change
  after first appearance, so **upsert** rather than insert and keep row identity stable.
- Pending transactions can vanish, change amount, or convert to posted with a _different_ id at some
  institutions. Policy is explicit in code and tested; vanished pendings become `status='void'` rather
  than being deleted.
- Responses include a structured `errlist`. **Surface those to the user rather than swallowing them.**

**The protocol is read-only, and that is a boundary rather than a gap.** It defines exactly four
endpoints — `GET /info`, `GET /create`, `POST /claim/:token`, `GET /accounts` — and **none of them
adds, removes or edits a linked institution**. That management lives in the SimpleFIN server's own
account and cannot be proxied: linking a bank means that bank's login, MFA and consent screens.

`GET /create` is not an API. The spec describes it as a page "an application directs a user to" —
the server authenticates them and walks them through producing a setup token. So Beans links to it
rather than reimplementing it, deriving the address from the stored access URL so a household on its
own SimpleFIN server gets its own. **That derivation strips the basic-auth userinfo by rebuilding
from `origin`, never by editing the string**, and returns null rather than anything partially
scrubbed — the access URL is a credential and this value reaches the browser.

Automating the server's web UI with a user's Bridge password was considered and rejected: it would
replace a revocable read-only credential with the one that can add or remove every connection, and
it breaks on any markup change or MFA prompt. Everything *after* linking — naming, typing, sign,
tax treatment, closing, deleting — is in Beans already, and newly linked accounts arrive through
re-discovery without a new token.

**Sync health is a first-class feature.** Per-connection and per-account status of `healthy` | `stale`
| `error` with last successful sync time. Silent sync failure is the worst possible bug in this app,
because the numbers quietly go stale and everything still looks fine.

**Reconnecting must preserve history.** Re-authorization replaces the stored access URL on the
_existing_ connection and re-matches accounts to existing rows via `simplefin_account_id`. Under no
circumstances may reconnecting create duplicate accounts or orphan balance history.

### 10.1 Holdings, as built

SimpleFIN optionally sends a `holdings` array per investment account. It is **genuinely absent from
many institutions** — a brokerage can report a balance and nothing about what is inside it — so
every layer treats an empty list as normal rather than as a failure, and the screen says "no
positions reported" rather than showing an empty portfolio. Nothing is missing from net worth when
holdings are absent; only the breakdown is.

**Stored as dated snapshots, one row per position per date, exactly like `balance_snapshots`.** A
position's value is a point-in-time observation, not an event that can be replayed: there is no
transaction to walk backwards through, because a share price moving is not something anybody posts.
The only way to say what a position did over a day is to have recorded it on both days.

- Writes are **delete-then-insert scoped to one date**, not upsert. A position that was sold has to
  disappear; an upsert would leave it sitting at its last known value forever and the positions
  would slowly stop adding up to the account's balance. Scoping to the date leaves history alone.
- Rows are dated to the provider's `balance-date`, so a position lands on the same day as the
  balance it belongs to. Dating to the sync instant would put a settled Monday position on Tuesday
  and make a day's move unmeasurable.
- **Nothing is written when the provider sends no positions.** Replacing a real set with nothing on
  the strength of a silent response would delete a portfolio.
- `provider_holding_id` stays plaintext, like `simplefin_account_id`. Symbol, description, share
  count and every amount are encrypted — a ticker is a statement about someone's finances even with
  no amount beside it. Ordering by value therefore happens in TypeScript; `market_value` is `bytea`
  and an `ORDER BY` on it would sort ciphertext into a convincing-looking arbitrary order (§3.1).
- **Share counts are strings, not cents.** A quantity is not an amount: it is routinely fractional,
  has no smallest unit to normalize to, and is never summed. It is carried verbatim so nothing
  invents a precision the provider did not state. Price per share is derived for display only and
  must never be multiplied back into a total — the market value is the authority.
- A position's change is a **plain difference between two observations**. Unlike an account there is
  no flow to net out, so shares bought or sold land in it exactly like a price move and nothing can
  tell them apart. The screen states this rather than implying the figure is the market alone.

**Served by `GET /api/accounts/:id/holdings`, not the working set.** The working set is what every
screen needs on every load and is mirrored into IndexedDB (§7); holdings are drill-down detail for
one account at a time, and pushing them through the delta cursor would grow every user's cache by
something almost none of them are looking at.

### 10.1a A security's own page, and why it filters in TypeScript

`GET /api/holdings/detail?symbol=&from=` answers "where is this security held, and what has it been
worth". The filter runs in application code after decryption, not in SQL, and that is **forced**:
`symbol` is `bytea`, so `where symbol = $1` has no ciphertext to compare against. The alternative is
deterministic encryption on that column, which would leak which rows across the whole table share a
symbol — a worse trade than the compute (§3.1).

The cost that buys is bounded by `from`, which the caller sets from the chart's range. It grows with
days × positions rather than with total history, which is the whole reason the parameter is required
rather than defaulted — a missing bound would quietly turn into a full-table decrypt a year from now.

A security's chart starts where Beans first recorded positions. Unlike a cash balance there is no
walking it backwards: a share price moving is not something anybody posts, so nothing before the
first snapshot exists to draw.

### 10.1b The personal index

The portfolio chart under **By holding** is performance, not composition — each day's return
measured market-only and the days chain-linked:

    return(d) = (close − open − flow) / (open + flow)
    index(d)  = (1 + index(d−1)) × (1 + return(d)) − 1

Chained rather than summed because returns compound; adding daily percentages drifts as soon as the
window is longer than a few weeks. Flows are stripped for the reason that runs through all of §10:
a contribution moves the balance and earns nothing, and a chart of raw percent change presents it as
a good day. **Where the provider reports no transactions the flow is zero and this degrades to plain
percent change** — the note under the chart says which of the two the reader is looking at.

Benchmarking it against a real index (Empower charts the S&P 500 beside theirs) is backlogged with
§10.2: it needs market data, and therefore the same decision about what leaves the machine.

### 10.1c Back navigation between two screens that link to each other

Account detail lists the positions inside an account; a holding page lists the accounts holding a
position. Each is the other's natural next question, so either can be arrived at from the other,
from the portfolio, or from a cold deep link.

A hardcoded back link cannot serve that, and the failure is not cosmetic: holding detail sending you
to the portfolio when you arrived from an account drops you somewhere you never were, and the only
route back to the account is to navigate down through it again. Two screens linking to each other,
each with a fixed exit, is how a person ends up circling.

So a link carries where it was opened from — `?from=<path>&fromLabel=<text>` — and the back control
reads it, falling back to its own default for a deep link or a bookmark.

**It carries the whole path, nested, not just the immediate parent.** Carrying one level was the
first attempt and it loses the case worth having: portfolio → account → holding, back twice, and you
land on the account's generic fallback rather than the portfolio you actually came through. The
screen you passed *through* is the one you least want to be dropped from. Nesting encodes each URL
inside the next, so a bound on the finished link's length drops the ancestry rather than emitting a
URL a browser refuses — a length bound rather than a depth count, because length is what breaks.

**Do not read the query with wouter's `useSearch()`.** It runs the search through `unescape()`, so
what it returns is percent-*decoded*: a nested `from` chain splits at the first `&` inside it, and a
label containing an ampersand — an account named "Stocks & Shares" — loses everything after it. Both
truncate silently. `useSearch()` is still called for its subscription, since the portfolio's grouping
toggle changes the query without touching the path; the value itself is read from
`window.location.search`.

**Which view a screen is showing belongs in the URL for the same reason.** The portfolio's
account/holding grouping was component state, so opening a holding from the grouped list and coming
back landed on the account breakdown — the screen forgetting which of its two views was being read.
In `?group=` it survives the round trip, a reload and a shared link. It is *replaced* rather than
pushed: switching the control is changing what you are looking at, not going somewhere, and stacking
history entries would make back undo a toggle.

`history.back()` was the alternative and is wrong here. Installed as a PWA there is no browser
chrome, so this control is the only way back and has to name its destination — an unlabelled arrow
in a two-screen cycle says nothing about which of them you are about to land on. A path in the query
string also survives a reload and a cold start, which `history` state does not.

**`from` is validated, not trusted.** It arrives in a URL, so it can be handed to somebody in a
link, and it renders as the app's own navigation wearing the app's own label. Only same-origin
absolute paths are honoured; `//host` is rejected alongside schemes, because protocol-relative URLs
pass a naive "starts with a slash" check and still leave the origin.

### 10.2 Allocation and sectors — backlogged, and why

Asset-class and sector breakdowns need something SimpleFIN does not send. A holding arrives as
symbol, description, shares, market value, cost basis, purchase price, currency. **Nothing in it
says what the security is.** No amount of work on the existing data produces "VWO is international
stocks" or "CDW is technology"; that requires security reference data Beans has never had.

Three ways to get it, recorded here so this is not re-litigated from scratch:

1. **A bundled offline table**, shipped in the repo, plus per-household overrides for what it misses.
   Resolves with no network and no API key. Coverage is partial by construction — broad-market ETFs,
   common index and money market funds, and large-cap US equities are tractable; the long tail is
   not — so a visible Unclassified share is permanent.
2. **An external market-data provider.** Broadest coverage and self-maintaining. **Rejected as the
   default.** Asking a third party to classify every ticker in the household hands them the
   composition of the portfolio. The request carries no amounts and it is still exactly what this
   app is self-hosted to avoid, and it would sit badly beside "the access URL never reaches the
   client" and "Postgres stays LAN-only". If it is ever built it belongs behind an explicit opt-in
   that states plainly what leaves the machine.
3. **Manual classification only.** Exact, private, no staleness, and it costs the user an afternoon
   up front plus a tag for every new holding.

Two further decisions that shape the work:

- **One asset class per fund.** Splitting a balanced or target-date fund across classes by its real
  composition is more accurate and needs per-fund look-through data no free source provides
  reliably. Single-asset-class index funds — most of what people hold — are exactly right under the
  simple model, and a blended fund should be left Unclassified rather than forced into one bucket.
- **A fund has no sector, only a blend.** Sectors are meaningful for directly-held equities and are
  a fabrication for a diversified fund. A sector view must therefore state what share of the
  portfolio it actually covers rather than implying it covers all of it.

For scale on the honest ceiling here: Empower, with commercial feeds, reports **27.73% Unclassified**
on a portfolio of this shape. A gap is normal rather than a defect — and a *wrong* classification is
much worse than an absent one, because a fund filed under the wrong asset class silently misstates
the split that retirement planning depends on. Nothing should ever be classified by guessing from
its ticker.

---


## 10.3 The demo account

A shared account anyone can sign into, so the app can be shown to somebody without them connecting
their own institution. Seeded by `pnpm demo:seed`, which is idempotent and clears the household's
financial data first — so it can run on a schedule to undo whatever visitors have done.

**Off unless `DEMO_EMAIL` and `DEMO_PASSWORD` are both set.** A demo button is a session handed to
anyone who can reach the host, which is not a decision Beans makes on an operator's behalf. Nothing
ships enabled and there is no default password.

Tenant isolation does the heavy lifting: the demo is a household like any other, so RLS keeps it
away from real data exactly as it keeps any two households apart (§6). **What isolation does not
cover is a visitor spending the deployment's own resources**, so two things are refused for the demo
user, both checked on the session's email rather than a stored flag:

- **Invites.** Sending real mail, from the operator's domain, on their key, to any address a
  stranger types is a spam relay wearing the app's clothes. There is no rate at which that is fine.
- **Claiming a SimpleFIN connection.** This one protects the *visitor*: attaching their real bank to
  an account everybody else can sign into would publish their finances to every future guest.

The seed writes transactions and lets `rebuildHouseholdHistory` derive the balances, rather than
fabricating snapshots — so the demo exercises reconstruction instead of illustrating it, and a bug
in that path shows up in the demo rather than hiding behind hand-written data. Investments are the
necessary exception: their value moves with the market and no transaction records it, so their
history is written as dated observations, which is the shape a real provider supplies (§4).

Deterministic, from a fixed seed. A demo somebody has been shown does not quietly become a different
one on the next reseed, and anything wrong with it can be reproduced.

---

## 11. Importing history

A **generic CSV mapper**, not an Empower-specific parser: auto-detect delimiter and header row,
present column mapping with a best-guess prefill, preview, then commit. Empower ships as a preset;
Monarch, Mint and YNAB are then just configuration.

- Supports both transaction history and balance/net-worth history.
- Staged in `import_rows` first — the user sees what will happen before anything touches real tables,
  and an import is reversible **as a unit**.
- **Seam handling:** imported and synced data overlap, and the same transaction appears in both with
  different descriptions. Overlap is detected by date proximity and amount, then presented for
  **manual confirmation**. Never silently merge; never silently duplicate. Once confirmed, a per-account
  **cutover date** is established: imported data owns everything before it, synced data everything after.
- After import, balance reconstruction reruns so the daily series is continuous across the seam.

**Retention:** `imports.reversible_until = committed_at + 30 days`. A scheduled job then **deletes the
`import_rows`** and keeps the `imports` header with its counts for audit. Reversal is impossible after
the window, which is the point — a five-year import is tens of thousands of staged rows carrying two
encrypted JSONB blobs each, and they would otherwise persist forever.

Real target data: the user's Empower transaction export runs back to **2019**.

### 11.1 Balance history import — the only route to investment history

Transactions can backfill cash and credit history because every change to those balances is a
posting: `balance(T) = current − sum(transactions after T)` closes. **It does not work for
investments.** A share price moving is not something anybody posts, so no transaction file recovers
what a brokerage was worth in 2019, and the portfolio chart starts when Beans first looked rather
than when the account did.

A balances CSV is a file of *readings* — account, date, balance — written straight into
`balance_snapshots` with `source = 'imported'`. That source is what protects them: rebuild deletes
only `derived` rows (§4.2), so a 2019 anchor survives every later rebuild instead of being
overwritten by reconstruction. Sparse rows are expected and fine; the realistic source is a statement
per month, and carry-forward fills the gaps.

**The kind is chosen, never inferred.** A balances file read as transactions inserts one fake
transaction per reading, and every balance derived afterwards is rebuilt from those — the damage
spreads far past the rows themselves and looks entirely plausible. The guesser proposes when it sees
a `balance` column and no `amount`; the reader confirms.

Parenthesised amounts are read as negative. `($281,640.00)` is accounting notation, it appears in
real statement exports, and read as positive it turns a quarter-million-dollar mortgage into a
quarter-million-dollar asset.

Snapshots carry `import_id` for the same reason transactions do. Without it, reversing a balances
import deleted nothing and reported success — the worst shape an undo can take, because the reader
is told it worked.

### 11.2 Export — the promise that you can leave

Beans exists because eight years of history sat in another app behind a one-month-at-a-time PDF
export. The export is therefore complete rather than convenient: accounts, transactions, and **one
row per account per day of balance history, every type, loans and investments included**.

The daily balances are the part that matters. Everything else in the file can be reconstructed
downstream by whoever receives it; an investment balance cannot, for the reason above. Leave the
snapshots out and that history is gone at the moment of leaving.

Money leaves as decimal strings, liabilities keep their sign, closed accounts are included, and
available balance appears — currently the only place it does other than account detail. What comes
out is plaintext, deliberately: everything is encrypted at rest under a key the operator holds, and
an export is the one moment a household asks for it in the clear. Over TLS, to an authenticated
session, `no-store`, never written to disk on the server.

---

## 12. Frontend

Two genuinely different layouts sharing all data logic, hooks and formatting — **not** one component
tree littered with breakpoint conditionals, which is how both layouts end up mediocre. The shell is
picked once at a breakpoint and each is allowed to be good at its own job.

### 12.0 One navigation order, two shells

The tab preference reached only the phone. The desktop sidebar rendered the static registry and
ignored it, so reordering navigation on a phone and opening a laptop showed no change — a setting
that silently applied to half the app.

Both shells now read one list to different depths: the first four entries are the bottom tabs, the
whole order is the sidebar. Promoting something to the top of the sidebar and wanting it in the
bottom bar are the same intent, and expressing it twice is how two lists drift apart.

The `tabbable` flag is gone with it. Accounts, import, household and settings were refused a slot on
the grounds that a one-off task should not occupy a thumb-sized target — a reasonable default,
encoded as a rule. This file already argued the opposite for categories and rules ("the whole point
of configurable tabs is not deciding that on their behalf") and then did the deciding anyway for four
others. The opinion belongs in `DEFAULT_TAB_ORDER`, where it still is.

**Import is deliberately not a destination**, though `/import` is still a real route. Being a
destination and being in the navigation are separable, and conflating them is what put a task most
people do once at the start permanently in front of everybody. It is reached from Manage accounts,
which is the same job — getting account data in. Anything that removes that link orphans the screen:
nothing else reaches it, including the More sheet, which lists the registry.

- **Mobile:** installable PWA — full manifest, service worker, offline shell, standalone display, iOS
  splash/icon sets, safe-area insets. Fixed bottom tab bar with exactly five slots; the fifth is
  always **More**. The first four are user-configurable and reordered from settings, persisted
  **server-side per user** (`user_preferences`) so they follow across devices.
- **Desktop:** persistent left sidebar, multi-pane. Where mobile stacks a chart above a list, desktop
  fixes the chart beside the scrolling list so it stays visible. Denser tables, sortable headers,
  multi-select, keyboard navigation.

### 12.1 Charts and the net worth transition

All chart code sits behind a thin wrapper so the renderer can be swapped.

**Decide what the transition is before deciding what can render it.** A true path morph between
categories will often look strange — morphing a dead-flat mortgage line into a jagged cash line
produces intermediate frames that mean nothing. The leading candidate is a **crossfade with an
animated y-axis rescale**, which is cheaper, reads more clearly, and is probably closer to what
Empower actually does; the axis rescale is what carries the "this is a different, smaller number"
meaning.

At milestone 7 the transition is **prototyped in isolation first**. Only then is the renderer
question opened. Outcome: hand-rolled SVG, crossfade at **140ms**. Recharts was declined — it owns
its own DOM and animation scheduling, and almost everything it provides beyond one filled path goes
unused here. The duration is short because this fires on every section crossing during an ordinary
scroll; a duration that reads as elegant once reads as lag by the tenth time.

Note for whoever revisits this: **uPlot does not solve the transition.** It is canvas and very fast at
drawing, but it has essentially no animation model — it buys draw speed, not smooth transitions. A
genuine morph means SVG with a path interpolator (e.g. flubber) or a hand-rolled canvas renderer
driving the tween on rAF.

Scroll-linked section behavior is driven by an **IntersectionObserver** rooted to the bottom edge of
the chart, never raw scroll offsets — scroll math breaks on variable row heights and on mobile
browser chrome resizing. `prefers-reduced-motion` swaps without animation. Section headers are
focusable and activating one scopes the chart directly, announced via a live region, so there is a
non-scroll path to the same result.

**Hysteresis is a pixel deadzone, not a settle delay.** The first implementation waited for scrolling
to stop before changing section, reading the spec's "change decisively, once, per crossing" as *once
per gesture*. It is not: the spec is about not oscillating at a boundary. Waiting for the scroll to
settle means a slow deliberate scroll changes nothing until the user stops, which reads as lag — and
was the first thing noticed in use. A new section now takes over as soon as it clears the line, but
must clear it by ~12px, which is what stops a pixel of movement toggling the chart back and forth.

Two consequences worth knowing:

- The **last section needs enough height to reach the detection line**, or the page runs out of
  scroll while it is still below the line and that category becomes unreachable by scrolling — with
  no visible symptom except one section that never activates.
- Measurement is coalesced to one `requestAnimationFrame`. The pending-frame handle **must** be
  cleared, not just cancelled, on cleanup: the guard that prevents double-measuring treats a set
  handle as "already queued", so a cancelled-but-recorded frame latches it closed and the hook goes
  silent forever. StrictMode's double-invoked mount effect triggers this on the first render.

---

### 12.2 Account detail and connection health

Tapping an account row opens `/accounts/:id` — the same chart, range control and sign conventions as
the section it came from, deliberately. An account is a smaller slice of the same thing, and a second
visual language for it would obscure the relationship rather than clarify it.

**Sync health resolves to a recommended action, not a status.** A red dot the user cannot act on
teaches them to ignore red dots. `assessConnection` in `packages/shared/src/connections/` maps
status, consecutive failure count and age onto one of `none` / `wait` / `sync-now` / `reconnect`, and
that verdict drives the banner, the button, the dot colour and the dot's screen-reader label alike —
so the row and the detail screen can never disagree.

The distinction that carries the design: **a failure Beans will retry out of is amber, not red.**
Reserving red for what genuinely needs the user is what keeps red meaningful. Two thresholds encode
it — three consecutive failures means the credentials went bad rather than the network hiccuping,
and thirty days of silence means a stale connection has become a broken one even though it never
errored. SimpleFIN can keep serving a stale balance without raising anything, so "no error" is not
evidence a connection works.

**A chart must never draw a period it has no data for.** An account whose connection broke in
December has no daily balances since; generating a plausible wiggle across those months puts
fabricated numbers directly under a banner saying the balance is from December. Balances are carried
flat after the last successful sync (the `carried` snapshot source, §4) and the flat stretch is
captioned with the date real data stops — a flat line on its own reads as "the balance did not
change", which is a claim Beans has no basis for. Manual accounts get the same treatment for the same
reason: one number somebody typed is not a daily series.

The banner sits **above** the balance. A caveat placed after the number it qualifies has already been
missed.

---

## 13. Deployment

### 13.0 One stack, not two

`docker/truenas.yaml` runs the database and the app together. An earlier note here claimed splitting
them protected the database from being recreated on an image update; **that was wrong** — a bind
mount is not a named volume, `initdb` runs only on an empty data directory, and `compose up` only
recreates services whose configuration changed. The database was never at risk either way.

The real reasons to combine are the ones that should have led:

- **Postgres does not need to be on the LAN.** The app reaches it by service name over the compose
  network, so no port is published and nothing outside the stack can connect — better than
  publishing 5432 and relying on nobody proxying it.
- The API applies migrations on boot, so it needs the database *ready*, not merely started.
  `depends_on: condition: service_healthy` says so; two separate apps cannot.

The one genuine hazard is running both arrangements at once: two Postgres containers over one data
directory is corruption, not a port conflict.

### 13.1 As built

One image serves the API and the built frontend from **one origin**, which is why production needs
no CORS and keeps `EXTRA_TRUSTED_ORIGINS` empty. `staticSiteRoutes` registers **last**, because its
not-found handler is the SPA fallback and would otherwise shadow real routes.

Three details that are easy to get wrong and silent when wrong:

- **`index.html` is served `no-cache`; fingerprinted assets are `immutable` for a year.** Vite
  fingerprints every asset, so long caching is safe for them — but `index.html` is the one file whose
  name never changes, and caching it pins every client to the build it first loaded. `sendFile`
  applies the plugin's configured cache options and overwrites a header set beforehand, so
  `cacheControl: false` has to be passed explicitly.
- **A request for `/` with `index: false` returns 403, not 404**, because it resolves to a directory
  and the static plugin refuses rather than declining — so it never reaches the fallback. An exact
  `/` route handles it.
- **An unknown `/api/*` path returns a JSON 404, not the SPA.** Falling back to HTML there answers a
  fetch with a page, and the client fails on a JSON parse rather than a status code.

The health check reports the database *and* the sync worker, and returns 503 when the worker has
stopped. A stopped worker means balances quietly stop updating while every request still succeeds —
precisely the failure that must not read as healthy.

CI runs typecheck and the full suite against a **real Postgres service container**, with
`TEST_DATABASE_URL` set so the integration tests run rather than skipping. A suite that silently
skips its cross-tenant isolation tests is worse than one that fails.



- Multi-stage Dockerfile producing **one image** serving the API and the built static frontend.
- `docker-compose.yml` with app, Postgres 16, healthchecks, named volumes, and the master key as a
  **Docker secret**.
- Migrations run on startup, **idempotently**.
- Config entirely through environment variables, documented in `.env.example`.
- `/health` checks database connectivity and reports sync worker status.
- Structured JSON logging with a **redaction list** — amounts, names, tokens and keys never reach logs.
- Backup script dumping Postgres, documented clearly: **a dump is worthless without the master key,
  and the master key must be backed up separately.**

### 13.1 TLS and hostname

Hosted at `https://beans.nerdspar.com`, behind a **Cloudflare tunnel** terminating TLS. The app does
not terminate TLS itself.

The tunnel replaced a reverse proxy on the LAN, and the reason is not the certificate — it is that
`cloudflared` dials *out* and holds the connection open. Nothing listens for the internet, nothing is
forwarded on the router, and the home IP is never published. A self-hosted finance app on a
residential connection otherwise means an open port on the same network as everything else in the
house, permanently, guarded by whatever the proxy is running that week.

The consequence worth writing down: **the app container publishes no port at all.** `cloudflared`
reaches it by service name over the compose network, exactly as the app reaches Postgres (§13). That
makes the tunnel the only route in, which is what lets the rate limiter trust `CF-Connecting-IP` —
Cloudflare always overwrites that header, so it cannot be forged by anyone who cannot bypass
Cloudflare, and with no published port nobody can. Publishing the port again would quietly undo it:
the header becomes whatever the caller says it is. The two settings are one decision, and
`docker/truenas.yaml` says so at both ends.

What is *not* claimed: Cloudflare terminates TLS, so it can see plaintext traffic. That is the trade
against exposing a residential IP and an inbound port, taken deliberately. The data at rest is
encrypted with a key Cloudflare never holds (§5), so the exposure is traffic in flight, not the
database.

A real hostname with a valid certificate is **required**, not cosmetic:

- Google OAuth redirect URIs reject IPs and `.local` names. Callback is
  `https://beans.nerdspar.com/api/auth/callback/google`.
- Service workers require a secure context. `localhost` is exempt; a LAN IP is not.

### 13.2 Development

Postgres runs in Docker **on TrueNAS** from day one, so dev and production are the same instance
family and the app service slots into that same compose file later. The app itself runs natively via
`pnpm dev` for fast iteration — developing inside a container means slow rebuilds, awkward debugger
attach, and fighting file-watch across a bind mount.

Two databases: `beans` and `beans_test`. Integration tests truncate tables and must never point at
dev data.

The Postgres port must stay **LAN-only** — never forwarded through the reverse proxy.

---

## 14. Testing

The suite must be runnable at any point with the math trusted. Not a checkbox at the end; tests are
written alongside each feature.

**Must have real coverage:**

- **Money parsing** — decimal strings to integer cents: negatives, thousands separators, missing
  decimals, more than two decimal places. Property-based over generated inputs.
- **Balance reconstruction** — exact against known fixtures. Boundary date, out-of-order postings,
  amended transactions, accounts with zero transactions in the window, and a fixture where
  reconstruction and later observed snapshots must agree at the seam.
- **Import seam** — imported plus synced history produces one continuous series, no double counting,
  no gap at cutover.
- **Transfer detection** — real pairs matched, near-miss coincidences not matched, confirmed transfers
  excluded from cash flow, and mortgage payments never paired.
- **Aggregation** — net worth, group subtotals, cash flow totals against hand-computed fixtures.
  Assets minus liabilities equals net worth in every fixture.
- **Encryption** — round trip for every encrypted column type, AAD binding rejecting a row moved
  between households, key rotation preserving readability of old rows.
- **Tenant isolation** — deliberate cross-household reads through the repository layer and through raw
  SQL under RLS, asserted to fail. **The most important tests in the repo.**
- **Sync idempotency** — same payload twice changes nothing; a pending transaction becoming posted
  updates in place rather than duplicating; reconnecting duplicates no accounts and orphans no history.

**Practices:** unit tests run against no database; integration tests run against real Postgres, never
a mock or SQLite. Deterministic fixtures with fixed dates — **never `new Date()` in a test**. A
dedicated `pnpm test:math` covers parsing, reconstruction, aggregation and transfers so the critical
path runs in seconds.

---

## 15. Ground rules

- Write tests as you go, not at the end.
- Keep this file current with decisions **and their reasoning**. Maintain `CLAUDE.md` with conventions.
- **No feature flags for things nobody asked for. No abstraction layers with a single implementation**,
  other than `KeyProvider`, which exists for the reason stated in §5.1.
- When something in the spec turns out to be wrong once in the code, **say so** rather than working
  around it.

---

## 16. Superseded spec lines

Recorded so a future session doesn't "restore" them:

| Original                                                  | Status                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "Transaction lists stay server-paginated and do refetch." | **Superseded** by §7. Encryption makes SQL-side filter/sort impossible; the working set moved to the client.                    |
| "Swap to uPlot if time-series scrubbing gets sluggish."   | **Amended** by §12.1. uPlot has no animation model and does not address the category transition. Transition design comes first. |

### 15.1 Connecting an institution, as built

`/connections` runs claim → confirm → sync. The confirmation step is the reason the flow has three
stages rather than one.

**SimpleFIN does not specify balance signs.** The protocol states a sign rule for transactions and
none for balances, so whether a credit card arrives as `-3386.39` or `3386.39` is up to the
institution and the Bridge does not normalize (§3.3). The confirmation screen therefore shows **both
numbers** — what SimpleFIN sent, and what Beans will record — because the user is being asked to
adjudicate between them and cannot do that if only the answer is shown.

The mismatch warning is recomputed from the user's current toggles rather than taken from the
server's `anomaly`, which describes the server's *suggestion*. Flipping the sign on a credit card
turns the figure green and raises "a credit card is money you owe, but this would be recorded as
money you have" while the choice is being made, not after it is committed.

A null `suggestedSignInverted` — low confidence, or a zero balance — defaults to **not** inverted.
Quietly flipping a sign nobody asked about is precisely the failure this screen exists to catch.

**`inverted` means negate what the provider sent. It does not mean "make this negative."** That
distinction is the whole reason `applySignConvention` lives in `packages/shared` rather than beside
the SimpleFIN client: the confirmation screen must apply the identical rule to the write path, and
when it had its own version it took the magnitude first. An institution reporting a card as
`-2132.77` — already correct for our convention — was displayed as `+$2,132.77` and flagged as
wrong, and acting on that flag would have stored `+2132.77`, doubling net worth in the plausible
direction. The screen exists to be believed, so it cannot hold its own opinion about what will be
recorded.

The suggestion is therefore per-institution and not a blanket flip: a liability is suggested for
inversion **only when the provider sent it positive**. Always inverting would break every institution
that already reports the sign we use.

### 14.1 Transactions

`/transactions` filters entirely in the browser: search, account and date range are a pass over an
array already in IndexedDB, and changing any of them issues **no request**. That is the point of §7
rather than an optimisation — descriptions and amounts are ciphertext in Postgres and cannot be
searched there at all, so the work has to happen wherever the plaintext is.

Amounts are searchable alongside text, because a half-remembered charge is the one thing somebody
can be certain of. The count reads "15 of 125" whenever a filter is active, so a short list is never
mistaken for a complete one.

**Money in is green; money out is plain.** Colouring every outgoing amount red would render an
ordinary week of groceries as a page of errors. Spending is not a problem, it is what a current
account is for, and marking the rarer direction is what makes the colour informative.

### 14.1a Categories and rules, as built

The default set is installed when a household is created, and `ensureDefaultCategories` is idempotent
on slug so it can be re-run — which is what `dev:backfill-categories` does for households that
predate it. Rules and CSV presets reference **slugs**, never display labels, so renaming a category
breaks nothing.

Matching is a pure function in `packages/shared`, and three of its decisions are deliberate:

- **First match wins**, by priority then creation order. Not "most specific" — a specificity
  heuristic reads better until two rules disagree and the user cannot tell which won or why.
- **A rule with no conditions matches nothing**, not everything. An empty rule is far more likely to
  be a half-finished edit than a deliberate catch-all, and the catch-all reading recategorizes the
  entire history in one click.
- **A malformed regex fails to match rather than throwing.** One bad pattern saved months ago must
  not stop today's sync categorizing anything at all.

**Rules only touch transactions with no category yet.** A rule must never overwrite an answer a
person gave; having one silently undo a deliberate choice is what makes people stop trusting
automatic categorization altogether. Verified end to end: a rule set a transaction to Groceries, it
was changed by hand to Restaurants, the rules were re-run, and it stayed Restaurants.

Categories are sent whole in the working set, like the confirmed transfer ids — a partial set would
render categorized transactions as uncategorized.

`/categories` lists the rules **in the order they are applied**, numbered, because that order decides
outcomes: the first matching rule wins, so being third rather than first is the difference between
two categories. Rules could be created from the transactions screen before this page existed, which
meant a household could accumulate automation it had no way to see or undo — worse than none, since
the effects are real and the cause is invisible.

Renaming categories and adding your own is **not built**. Rules reference a stable slug rather than a
label, so a rename will not break them when it is.

### 14.2 Cash flow, as built

`/cash-flow` totals income and spending by calendar month, and its correctness rests entirely on
excluding transfers. Paying a credit card is an outflow from checking and an inflow to the card;
counted naively it adds the same amount to **both** sides. Net is unaffected, which is exactly why
the error survives inspection — observed directly: confirming one $400 payment took $400 off income
and $400 off spending, and left net identical.

Exclusion lives in one function in `packages/shared` (§9) and the screen calls it. Detection is a
pure function too, so the mortgage case is testable without a database: a payment leaves checking as
one amount while the balance drops by only the principal, so the amounts differ and the matcher
declines. **A test asserts that refusal**, because loosening the tolerance is the obvious improvement
and would silently erase interest expense.

Nothing is excluded on the strength of a proposal — only confirmation. A matcher quietly deciding
what counts as income would be worse than no matcher. The count of what was excluded is shown, so a
total that ignores some transactions is never doing it silently.

The category breakdown reports **Uncategorized as its own bucket** rather than dropping it. A
breakdown that quietly omitted a third of the spending would be worse than one saying a third is
unsorted: the second is a prompt, the first is a wrong answer.

Spending stays **negative** through every layer and is negated only for display. The screen also uses
words for a month's result — "$412 more than you earned" rather than a bare negative — because for a
monthly figure the direction is the point, and the wording stays plain: no commiseration, no
encouragement, no joke.

### 14.3 Portfolio, household, import

**Portfolio is account level**, because that is what the data supports: SimpleFIN reports a balance
per investment account and no holdings inside it, so no positions are shown and none are implied.
The one breakdown that is both available and consequential is tax treatment — it decides what a
withdrawal is worth, and phase 5 projection depends on it. The screen states that history begins when
Beans first saw each account, since an investment balance cannot be reconstructed backwards (§4) and
a short chart is a fact about Beans rather than about the account.

**Inviting** is the only action whose effect reaches another person, and it is irreversible in the
sense that matters: revoking does not unsee a balance. What joining exposes is stated above the
field, not discovered afterwards. The member list shows user ids rather than emails because the
household endpoint deliberately does not expose other people's addresses.

**Import** is four steps and the order is the point: nothing reaches `transactions` until the rows
have been looked at. Staging parses into `import_rows`; the preview reads from there. The mapping
step shows **sample values, not just headers** — "Amount" and "Debit" look equally plausible until
you notice one column is never negative, which is the mistake that inverts a year of spending.
Reversal exists for the mistake found later still.

### 14.4 The working set belongs to a household

The cache records which household it holds and empties itself when that changes. Sign-out clears it,
so ordinarily this never fires; it exists for the cases where sign-out did not happen — a failed
request, a tab closed mid-flight, an expired cookie and a different person signing in on the same
device. Syncing a delta on top of the previous household's rows would merge two people's finances
into one net worth and nothing downstream would notice. Verified by planting a foreign household id:
30 stale accounts were detected, cleared, and resynced to the correct 10.

### 15.1a Managing accounts

`/accounts` lists every account grouped by the connection it came from, with manual accounts as
their own group. It replaced a separate connections page that listed one connection and was
otherwise empty — **a connection is not something anybody thinks about**, it is how some accounts
arrive. Grouping by it puts sync health beside the accounts it affects, and makes manual accounts
just another group rather than a homeless special case.

**Accounts are grouped by institution, not by connection.** A SimpleFIN Bridge account is one
connection exposing every institution linked inside it, so grouping by connection produces a single
bucket containing everything — and rendering the connection's controls per group made `Sync now` and
`Review accounts` look like per-account actions. Connection health is now one card at the top; the
institution is the distinction a person actually makes. A second connection exists only for a
household member with their own Bridge account, so adding one is a quiet link rather than a
competing primary action.

**There is no separate connections screen.** There was, and it listed one connection and hosted
three flows that the accounts page linked out to — claiming a connection, re-confirming the
provider's answers, and replacing a credential. A page whose only purpose is to be bounced to is
worse than those flows living where the accounts are, so they are stages of this screen.

**Deleting offers closing first.** Closing keeps the transactions and the history and merely stops
the account counting, which is right for an account that was real; deletion is for one added by
mistake. The confirmation names the number of transactions that would go, so the warning is a figure
rather than an adjective, and the destructive button is never the one under the thumb.

Deletion writes a **tombstone** — one for the account, not thousands for its rows. Foreign keys
cascade server-side, but every client holds its own copy in IndexedDB and learns about removals only
from the `deletions` log; without the row the account would sit in the working set of every device
the household has signed in from, permanently, with nothing able to remove it (§7.3).

Editing rules worth knowing:

- **A sign change rewrites history; a rename does not.** `provider_sign_inverted` applies to the
  balance only, never to transaction amounts, so flipping it negates the stored balance — and every
  derived snapshot came from that balance, so `rebuildAccountHistory` runs. Without it the headline
  figure would move while the whole series stayed on the wrong side of zero.
- The balance is **negated, not recomputed**, because the provider's original figure is not stored —
  only our reading of it. Negation is exactly the inverse of `applySignConvention`.
- **Revisiting a connection defaults to what is stored, not to a fresh guess.** It previously
  re-proposed the type guess over answers the user had already given, so fixing a sign silently
  reverted a corrected type. `type_is_user_set` exists to stop sync doing that; this was the one
  remaining path that could.
- A manual account is created **confirmed**. The confirmation gate exists to make a human check a
  *provider's* sign (§3.3); a figure the user typed has already had that attention.
- Manual balances are a **step function** — each entry held flat until the next. Nobody knows what a
  house was worth between two valuations, and interpolating would invent the months between them.
- The user types a positive number and the **type decides the sign**, so recording a debt never
  requires remembering a minus sign.

### 15.2 Coverage boundaries in a rollup

Accounts do not share a coverage start. Backward reconstruction gives cash and credit a year of
history the moment they connect; an investment account gets **one day**, because its value moves with
the market rather than with postings and reconstructing it backwards would be arithmetically fine and
factually invented (§4).

Summing across that boundary yields a total silently missing whichever accounts do not reach that far
back. On a first connection it renders as net worth sitting near zero for a year and then leaping by
the value of the brokerage on the day it was added — observed, not hypothesized, the first time this
flow ran end to end.

The original answer was to start a summed series at the **latest** first-date among its parts and
discard everything before it: less history, all of it real. **That was wrong, and it was replaced.**

It is free on a first connection, where there is no history to lose, and ruinous afterwards. Every
account added later re-truncates the entire chart, so the household series can never be longer than
its newest account — a year of net worth disappears the day a house is added, and it can never
accumulate again because the next addition does the same thing. Reported from real use, not
theorized.

So **a summed series starts at the earliest first-date among its parts**, each part contributing from
its own start, and it carries `completeFrom` — the first date every part reaches. Before that date
the total is real but partial. The chart washes that region out behind the line and marks the
boundary with a dashed rule; the screen says "Before 8/3/2026, this leaves out accounts whose history
does not reach that far back."

The step where the remaining accounts join is still there and is still not a gain. The difference is
that it is now labelled rather than avoided — the fill, the rule and the sentence all point at it.
Hiding a year of history to prevent one misreadable step traded a small, explicable error for a large
one, and the small one is the only kind that can be explained.

A related rendering rule: **one data point is drawn as a flat line across the full width**, not as a
point at the midpoint. The latter makes the area fan out from the baseline and back, which reads as a
balance that rose and fell within the window. This is the normal state immediately after connecting.

### 16.0 Authentication surfaces

**Every transition across the auth boundary is a full page load**, not a cache invalidation: signing
in, signing up, creating a household, and signing out all end with `location.assign('/')`.

This is not stylistic. The working-set sync query parks in an error state — `NotSignedInError` or
`NoHouseholdYetError`, both with retries disabled because they are settled answers rather than
flakes — and it does not refetch when the session appears. Invalidating the session query alone left
a form that accepted valid credentials and then sat there: the session was real, the screen never
moved, and a manual refresh was the only way through. Each of these happens once per session, so a
clean boot costs nothing and removes every ordering question at once. The sign-out case has the
additional argument in §7.4a.

Password policy lives in `packages/shared/src/auth/password.ts` and both sides read it. They did not
originally: the API required twelve characters while the form validated at eight and said so, so an
eight-character password passed the form and was refused by the server. The copy is generated from
the constant, and a test asserts no other number appears in it.

`Gate` in `App.tsx` decides whether the app is reachable: no session renders `SignIn`, a session
without a household renders `CreateHousehold`, and only then does the shell mount. Both render
**outside the shell** — bottom tabs a user cannot use are noise at best and imply something behind
them at worst.

Consequently the net worth screen does **not** handle signed-out or no-household states. Branches for
them would be unreachable, and unreachable branches only drift.

Base colours (`bg-slate-50 text-slate-900 dark:…`) live on `body`, not only on the shells. Anything
rendered outside a shell — these two screens, any Radix portal — otherwise inherits the browser
default and lands dark-on-dark in dark mode, which is invisible until somebody opens it in the wrong
theme.

A **server failure is never reported as a bad password.** A 5xx or an unreachable API says so; only
Better Auth's own rejection blames the credentials. Sending somebody to reset a password that was
never the problem is the worse failure, and on a self-hosted app "the server is not answering" is
genuinely actionable.

The same applies to **throttling, which is a wait rather than a rejection**. Sign-up allows three
attempts per five minutes and sign-in five per minute, both reachable by a household setting up two
accounts — and a 429 read as a credential failure is exactly the case above. The remaining seconds
come back in `x-retry-after` and are stated. When the server explains itself at all its `message` is
shown verbatim, because "User already exists" is both true and actionable where a guess from the
client is neither.

### 16.1 Development-only configuration

`EXTRA_TRUSTED_ORIGINS` exists because Better Auth's CSRF check compares the request origin against
`trustedOrigins`, which was `[PUBLIC_URL]` — the API's own origin. In production one container serves
the API and the built frontend from that origin and the check passes. **In development the two run on
different ports**, so every auth request is cross-origin and returns `INVALID_ORIGIN`. Enumerated
rather than wildcarded: this list is the CSRF boundary. Empty in production.

`pnpm --filter @beans/api dev:seed <email>` fills a household with plausible accounts and two years
of daily snapshots. It goes through `withHouseholdContext` because every money and name column is
encrypted with the household's own key — none of this is seedable from psql.

---

## 17. Library versions and their gotchas

Verified against the live registries and docs at milestone 1, not from memory. Several of these
libraries changed enough recently that older knowledge is actively wrong.

| Package       | Pinned      | Why it's pinned / what bites                                                                                                                                                                    |
| ------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-orm` | **0.45.2**  | orm.drizzle.team now documents **v1 (RC)**, which is not what `npm i` gives you. v1-only APIs absent from stable: `bytea`, `pgTable.withRLS()`, `getColumns()`, `defineRelations()`.            |
| `drizzle-kit` | **0.31.10** | `migrate()` **requires** a config argument on this line; the docs' `migrate(db)` is v1-only.                                                                                                    |
| `pg-boss`     | **12.x**    | v12 dropped the default export — `import { PgBoss }`, not `import PgBoss`. Queues must be created explicitly before `send()`. Handlers always receive an **array**. Requires Node ≥22.12.       |
| `better-auth` | **1.6.x**   | CLI is now `npx auth@latest generate` (not `@better-auth/cli`, frozen at 1.4.21). Drizzle adapter moved to `@better-auth/drizzle-adapter`. Generated columns are **snake_case** by default now. |
| `vitest`      | 4.x         | —                                                                                                                                                                                               |
| `typescript`  | 5.9.x       | TS 7 (the native port) is published but the tooling around Drizzle/Vite hasn't caught up. Revisit later.                                                                                        |

Specific traps already hit or avoided:

- **`nullsNotDistinct()` exists only on `unique()` table constraints, not on `uniqueIndex()`** — and
  therefore **cannot be combined with a partial index**, since constraints take no `WHERE`. Our
  schema happens not to need that combination (`categories` needs NULLS NOT DISTINCT with no WHERE;
  `transfer_matches` needs partial uniques with no NULL semantics), but a future table might. If so,
  hand-write the `CREATE UNIQUE INDEX ... NULLS NOT DISTINCT ... WHERE ...` in a custom migration.
- **Drizzle cannot express triggers.** `updated_at`, the two-level category cap, and the system-slug
  guard are all hand-written in `0001_triggers.sql` via `drizzle-kit generate --custom`. drizzle-kit
  never introspects triggers, so it will not drop them — but write them `CREATE OR REPLACE` /
  `DROP ... IF EXISTS` so re-runs stay safe.
- **Drizzle _can_ express RLS** (`pgPolicy` + `.enableRLS()`), and does emit it. But not FORCE — see §6.
- **pg-boss gets its own connection pool, not the app's.** Our RLS design sets `app.current_household`
  as session state on connections; sharing a pool would leak that state into pg-boss's own queries.
  A separate small pool sidesteps the whole class of problem.
- **Better Auth defaults to scrypt, not Argon2id.** Argon2id is configured explicitly via
  `emailAndPassword.password.{hash,verify}` with `@node-rs/argon2`. This must be decided **before**
  any user exists — existing scrypt hashes will not verify under an Argon2-only verifier.
- **Fastify + Better Auth: do not copy the documented header loop verbatim.** `reply.header()`
  overwrites on repeat keys, which collapses multiple `Set-Cookie` headers (session token plus
  `dont_remember`, or OAuth state). Use `reply.raw.setHeader('set-cookie', response.headers.getSetCookie())`.
- **Migrations are not concurrency-safe across simultaneously booting replicas.** Startup migration
  is wrapped in a `pg_advisory_lock`.

## 18. Open items

| Item                                        | Status                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdings                                    | **Built** — see §10.1. Positions are parsed, stored as dated snapshots, and shown per account and grouped by security across accounts.                                                                                                                                            |
| Allocation and sectors                      | **Backlogged**, and the blocker is data rather than effort — see §10.2 for the decision and its reasoning, which should be read before anyone starts it.                                                                                                                          |
| Budgeting (Phase 4)                         | Seam exists: `category_targets(category_id, month, amount)` attaches to stable `categories`. Not built.                                                                                                                                                                           |
| Retirement (Phase 5)                        | **Phase A foundation in progress** — see §19. Tax buckets, carry-forward and the after-tax equivalent are built; the wizard and the projection are not. Phases B–D are not started, and B is blocked on user-supplied IRS reference data.                                          |
| Tax profile (Phase 6)                       | New household-keyed tables. Depends on `tax_treatment` being populated and cash flow being clean, which is why both are handled properly in phase 1.                                                                                                                              |
| Subscriptions          | **Built** — see §20. Detection only; nothing cancels anything, and no notifications fire on a new series or a price rise.                                                                                                                                                         |
| Institution logos                           | If added, they go in a **separate global public table keyed by domain with no household reference**. The household-scoped row keeps its own encrypted name. Do not add a global FK from households to institutions — that would reveal which institutions a household banks with. |
## 19. Retirement planning

Phase A of `beans-retirement-spec.md`. The premise is that Beans replaces guesses with observations:
it knows what is held, how it is taxed, what is actually spent, and — once asked — when the mortgage
ends. Everything it cannot know is asked for or declared, never estimated quietly.

**Nothing here writes back to the financial record.** The planner reads `accounts`, `transactions`
and `balance_snapshots` and writes only to its own tables. A projection can be rerun, argued with or
thrown away without a cent of observed history moving.

### 19.1 Tax buckets carry forward; they are not a stored percentage

A single 401(k) commonly holds pre-tax, Roth and after-tax non-Roth money at once, and SimpleFIN
reports one balance for the account and will never break it out. So the split is a user-maintained
overlay: they read a breakdown off their provider and enter it, and that row is an **anchor**.

A fixed percentage is wrong and drifts. A frozen traditional balance beside an actively contributed
Roth balance changes ratio every year on its own — growth alone preserves a ratio, contributions do
not. `carryBucketsForward` models that year by year, and there is a test asserting exactly this case
over a decade, with a control asserting that growth alone moves nothing.

Two things fell out of building it that are worth keeping written down:

- **Weights are carried unrounded.** Rounding each bucket every year left a 60/40 split off by a
  cent after ten growth steps — growth appearing to move a ratio it mathematically cannot move. The
  loop multiplies by `10_000 + rate` and tracks the matching power of ten thousand, deferring the
  divisor to the end. The numbers get large and stay exact, which is the right trade for money.
- **The carry-forward produces proportions, not balances.** The spec described carrying balances
  forward directly. That would let a ten-year-old anchor drift away from the number the institution
  reports today, which throws away the one thing Beans has that a calculator does not. Assumptions
  decide how the pie is sliced; the provider decides how big it is.

`accounts.tax_treatment` stays as the account-level fallback and remains authoritative for every
account nobody has broken out. Net worth, the account list and every phase 1 view are unaffected.

### 19.2 `after_tax` is a seventh tax treatment, not a flavour of taxable

After-tax non-Roth money inside an employer plan is a third thing: the contributions are
already-taxed basis, and the earnings on them are taxed as **ordinary income** on withdrawal.
Folding it into `taxable` or `traditional` would misstate the after-tax equivalent in a specific
direction, and it is the bucket the mega-backdoor rules are entirely about.

Adding it exposed a drift the schema had been carrying quietly: `TAX_TREATMENTS`, the Postgres enum
and two hand-written `z.enum([...])` literals in the routes were four copies of one vocabulary, and
only two of them moved. The validators now derive from the shared constant, so that failure is a
type error rather than a 400 nobody can explain.

### 19.3 The after-tax equivalent, and the two things it cannot see

A million dollars in a traditional 401(k) is not a million dollars, and almost no tool says so. The
figure is shown **beside** net worth, never instead of it, with the assumed rate inline: net worth
is a fact, and this is a fact plus an assumption.

Only `traditional` carries a deferred tax bill. Two deliberate exclusions:

- **HSA and 529 are not pre-tax.** Qualified withdrawals are tax-free, which is the entire point of
  holding them. Taxing them would tell somebody their HSA is worth less than it is. They become
  taxable only on a non-qualified withdrawal — a choice the holder has not made and Beans must not
  assume for them.
- **`taxable` and `after_tax` are taken at face value with a flag**, not a guessed haircut. The
  unknowns differ — embedded capital gains in one, ordinary-income earnings in the other — but the
  cause is the same: no cost basis (§10.1), and no basis-versus-earnings split from any provider.
  `ignoresEmbeddedGains` is what lets the UI say so out loud instead of quietly shaving 15%. It sets
  only when such a balance is actually present, so the note does not become furniture.

### 19.4 Schema, and three departures from the spec

Eight tables, all household-scoped, all `FORCE ROW LEVEL SECURITY`, all carrying the `updated_at`
trigger except `projection_runs`, which is immutable and has `created_at` alone.

- **No `dollars_basis` column.** The spec fixes it to `real`. A column with one legal value
  advertises a choice that does not exist. Real dollars is a property of the engine, stated on
  screen beside every figure.
- **No `is_anchor` on `account_tax_buckets`.** Carry-forward is computed, not persisted, so every
  row is an anchor by construction. A column that is always true eventually gets written false.
- **No planning-horizon column.** `retirement_members.life_expectancy` already determines it, and
  two sources for one number is how they come to disagree.

Smaller ones, each for a reason the codebase supplies:

- `projection_runs.inputs` and `.results` are **`bytea`, not `jsonb`** — encrypted JSON. The spec
  asked for both at once and they are mutually exclusive (§3.1, §7).
- `account_contribution_routing` stores an **annual amount, not a percentage of salary**. Beans has
  no salary figure: pay arrives as deposits net of withholding, and a 401(k) deferral never appears
  as a transaction at all.
- `retirement_scenarios` shifts retirement by **years, not to an absolute date**. Members retire on
  different dates, so one date on the scenario would have to overwrite both — and "retire two years
  earlier" is the question people actually ask.
- `retirement_members` is separate from `household_members`. A spouse who never signs in still
  retires on a date and claims Social Security on a schedule.

**The three account-scoped tables must be read through a join on `accounts`.** Their RLS policies
check `household_id` alone; the private-account rule (`is_shared or owner_user_id = me`, §6.4) lives
on the `accounts` policy, so it reaches a child row only when the query joins `accounts` and lets
that policy filter it. Every existing child query does this — `transactions`, `balance_snapshots`
and `holdings` in both the working set and the export all join `accounts` rather than filtering by
`account_id` alone, which is what keeps one member's private account private. A repository that
selects from `account_tax_buckets` by `account_id` alone would quietly hand another member the tax
breakdown of an account they cannot see.

`accounts.payoff_date` is **asked for, not derived**. Beans has a balance and a transaction history,
not an amortization schedule — no rate, no term, no principal/interest split, and extra payments are
indistinguishable from ordinary ones. It lives on `accounts` because it is a fact about the loan,
true whether or not anyone opens the planner.

### 19.4a The projection, and the order it does things in

Annual timestep, real dollars, three scenarios at once rendered as a **band rather than a line**.
A point estimate implies a precision that does not exist.

The per-year order deviates from the spec's in two places, and every difference moves the number
**down**: withdrawals happen before growth, so a year's spending does not earn a year's return on
its way out; contributions happen after growth, so a year's contributions do not earn a full year
of return in the year they are spread across. The second also matches `carryBucketsForward`, and
the two disagreeing would make the bucket split and the balance path tell different stories about
the same account. For a retirement projection the safe direction is down — a model that flatters by
a few percent a year compounds into a plan that says somebody can stop working a year early.

**Tax on a pre-tax withdrawal is grossed up analytically.** Withdrawing exactly what is needed and
then paying tax out of it leaves the year short by the tax while the plan reports that it held. For
a flat rate the gross-up is exact, so no iterate-until-it-converges loop is needed.

**The household retires when its first member does**, which is when contributions stop and
withdrawals start. Deliberate and conservative: where one person keeps working their wages really
do fund part of the household, but Beans has no salary figure, so the choice is between starting
the drawdown early — which understates the plan — and inventing an income, which flatters it.
Modelling the gap years properly is phase D.

**`hsa` and `education` are not in the withdrawal order.** They hold real money the plan does not
spend: an HSA is for medical costs and a 529 carries a penalty for anything else. Their balance is
reported as `heldBackCents` so the terminal figure cannot read as money available for spending.

**Social Security starts at each member's own claim age**, never averaged. The years between one
member claiming and the other are exactly the years a plan is most likely to come up short, and
smearing them hides that. A null claim age counts nothing — unasked is not the same as zero.

Rounding is **half away from zero**, in one place (`rates.ts`). Spending is negative throughout, so
BigInt truncation toward zero would shave a cent off every cost, every year, always in the
flattering direction. Bias in a retirement number is worse than error.

**What the projection does not model, it declares.** `notModelled` carries
`required_minimum_distributions` and `social_security_taxation`, and the UI is obliged to state
them beside the figures. RMDs are blocked on two things rather than one: the statutory start age
and lifetime table must come from the reference table, **and** buckets would have to be
attributable to an individual member, which the schema supports only through a thin account-owner
chain. This is the lesson from the drift detector written down — a check that cannot fire and looks
like it did is worse than an absence that says so.

**The funded ratio is read off the simulated path, not computed from a parallel present-value
model.** The obvious implementation — discount the spending, discount the benefits, divide — is a
second model, and a second model disagrees with the first: it cannot see the tax gross-up, the
withdrawal order, or the buckets the plan holds back. A headline saying "fully funded" above a chart
that visibly runs dry is the single fastest way to lose a reader's trust in a planner. So the ratio
is the present value of the need the simulation *met* over the need it faced, which makes a run with
no shortfall exactly 10000 by construction. `gapCents` is the present value of what it could not
fund — and, because it is discounted at the scenario's own return assumptions, also the amount that
would have to be added today to close it. A horizon with no retirement year reports a **null** ratio
rather than 100%: nothing to fund is not the same as fully funded.

Monte Carlo is phase C and earns its place for one reason worth stating: **sequence-of-returns
risk**. A deterministic model averaging six percent and a real market averaging six percent diverge
badly when the poor years land in the first five years of retirement, and a deterministic path
cannot express that because it has no sequence. Historical bootstrapping is preferred to random
normal draws.

### 19.4b A private account's spending is outside the household baseline

Decided deliberately, and the consequence is visible rather than hidden: **two members of one
household see different retirement projections.** The owner's baseline includes spending the other
member cannot see, so their plan is more expensive and less funded.

This follows §6.4 — a private account is out of every rollup, and the retirement baseline is a
rollup. `readSpendingWindow` joins `accounts`, so the `accounts` policy does the excluding and
nothing in the retirement tables has to know about visibility.

The alternative considered was summing every household account into the baseline total while hiding
the per-category breakdown. That gives one coherent plan both members agree on, and it leaks:
subtract the visible categories from the total and you have inferred roughly what is being spent on
the hidden account. **A privacy rule that can be defeated with arithmetic is not one.** The
per-viewer difference is the honest cost of marking an account private, and it is arguably the
correct answer anyway — each person's projection reflects what they actually know.

A third option — refusing to run the plan at all while a private account exists — was rejected
because it lets one member's privacy choice disable a shared feature for the other.

### 19.4c Reads on a household context are sequential, never `Promise.all`

Not a style preference. Every repository call inside `withHouseholdContext` shares that
transaction's single `PoolClient`, and one connection cannot run queries concurrently:
node-postgres serializes them and warns that it will **stop doing so in pg@9**. So `Promise.all`
over a context's reads reads as a speed-up, delivers none, and breaks on a major version bump.

`readWorkingSet` has carried this note since it was written. The retirement plan reader and the
projection service both reintroduced the mistake anyway, and what caught it was a deprecation
warning in integration test output rather than any assertion — which is the argument for reading
test output rather than only its pass count.

### 19.4d The screens, and what they refuse to compute

Two of them. `/retirement` is the dashboard plus the people in the plan; `/retirement/setup` is
accounts, spending and return assumptions. Revisitable rather than a one-time flow — the spec calls
it a wizard and the ordering keeps its intent, but it is a page you come back to and change one
answer on, because that is what people do with a plan.

**The projection is computed on the server; the setup screens are computed in the browser.** Not an
inconsistency. The projection needs a trailing year of transactions plus every retirement table,
none of which is in the working set, so shipping it all to the client to avoid one request would be
the wrong trade. The spending review needs descriptions and amounts grouped by category, which the
server cannot do without decrypting every row — and the client already holds the whole working set.
Both run the *same* shared helpers over the same window (`spendingByCategory`, the 365-day
baseline), so the review and the projection cannot disagree about what a year of spending was.

**The band is drawn from values, never from the order scenarios arrive in.** The engine is monotonic
in the return rate so the seeded three come back ordered, but every rate is editable: raise the
return on "Markets disappoint" and a position-keyed band renders upside down with the fill inverted.

**Zero is always on the projection's axis**, drawn solid where the gridlines are dashed. The question
the chart answers is whether the money lasts, so a band scaled to its own minimum — making a plan
that merely dips look like one that ended — would be answering a different question.

Three things the screens deliberately do not do:

- **The tax treatment is edited on the account, not in the setup.** Two screens writing one field is
  how they come to disagree about it; the setup links across instead.
- **A loan's payoff year is offered, never applied.** Which category pays which loan is something
  only the household knows, and nothing in the schema links them (§19.4a). Guessing wrong drops a
  whole category on the wrong date.
- **Plan-feature questions are offered on investment accounts without claiming to know which is an
  employer plan.** Beans cannot know that. Each answer is yes / no / **don't know**, and the third
  is the load-bearing one.

**Healthcare before 65 is its own input, charged while a retired member is under 65.** Averaging it
into a spending category makes the expensive early years disappear — for exactly the people
retiring early, who most need the figure to be right. It is checked per member rather than against
the household's retirement year, so somebody who retires at 67 never triggers it. The entered cost
is a household figure charged once while anybody needs the bridge; per-member costs, real plan
pricing and the subsidy cliff are phase D. This is deliberately the cruder thing that is visible
rather than the finer thing that is absent.

**`projection_runs` is created and nothing writes to it yet.** Plan history is phase D. The table is
inert rather than wrong — no code reads it and no screen implies it has contents — but it is dead
schema until then, and worth knowing about rather than discovering.

**The after-tax equivalent is shown on the retirement dashboard, not on the net worth screen.** The
spec says "beside net worth", and this honours the intent rather than the letter: most households
never open the planner, and putting a rate-dependent figure on the main screen would show everybody
a number resting on a default nobody chose. Both figures appear together with the rate inline, and
neither replaces the other — net worth is a fact, this is a fact plus an assumption.

**Whenever any scenario runs out, the screen says so, even when the headline one does not.** The
funded outcome describes the default scenario alone, which produced "Lasts the whole plan" directly
beneath a band reading "$0.00 to $1,904,892.62" — the reader told the plan holds while looking at a
picture of it not holding. It is the §19.4b failure in a different costume, and it was found by
reading the rendered page rather than by any assertion.

Copy lives in `packages/shared/src/copy/retirement.ts`, and this is the screen where the no-jokes
rule matters most: a depletion year and a funding gap are numbers moving badly for the person
reading them. They are stated flat, with the assumption beside them, and nothing is phrased as a
recommendation.

Two bugs here were found only by looking at the rendered page, which is the argument for looking: a
seeded 3.5% return displayed as "4%", so the assumption shown was not the one that produced the
figures; and the shared chart-table caption told screen-reader users to "use the chart slider for
any single day" on a chart with no slider that plots calendar years.

### 19.5 Statutory figures, and the gate in front of them

`contribution_limits` exists and ships **empty of real figures on purpose**. This is the one line of
the retirement spec that does not bend: contribution limits, phaseout thresholds, catch-up tiers and
RMD ages change every year and several have phased in on staggered schedules with at least one delay
along the way. A figure recalled rather than read is confidently wrong about somebody's real money.

So the table ships as a **review checklist**: one row per figure the feature needs, each naming what
to look up and linking to its source, each carrying a placeholder and `verified_at = null`.

Four properties hold it together, and each is mutation-tested:

- **Nothing may compute from a row until `verified_at` is set.** `lookupReference` returns a union —
  `ok`, `missing`, `unverified`, `wrong_unit` — so "no figure available" cannot be mistaken for a
  number. Returning `bigint | null` would have put the burden on every caller to remember the check,
  and the one that forgot would produce a confident wrong answer.
- **No figure is ever carried between years.** Last year's limit is not this year's, and a silent
  fallback is indistinguishable from a correct answer right up until somebody acts on it.
- **Placeholders are deliberately absurd.** `PLACEHOLDER_VALUE` is `1`. A placeholder of `2350000`
  looks checked, and the next reader has no way to know it was invented — which is exactly the
  failure being prevented. One cent is self-evidently not a contribution limit, so if one ever
  escaped the gate it would read as broken rather than as an answer. The same rule governs the
  screen's own worked examples: the first draft used "$23,500.00 is 2350000", which reads like the
  answer, and now uses $12.34.
- **The unit is checked before the gate.** The table holds money, ages and percentages side by side,
  and an age read as cents is the kind of mistake that produces a wrong answer rather than an error.
  Reporting it as merely "unverified" would send somebody to tick a box instead of to the code.

**The red banner is the only one in Beans.** Everywhere else a caveat is a quiet note, because what
is being caveated is an assumption the reader can see and argue with. A contribution limit is not an
assumption — it is a published fact with a right answer that somebody could act on and be wrong
about by law. The banner names how many figures are outstanding, links to the review screen, and
disappears entirely once the year is complete; a banner that is always there is furniture.

**`contribution_limits` is the one table with no `household_id` and no RLS.** These are figures the
IRS publishes: the same for every household, personal to nobody, derived from nobody's data. One
copy per household would be a guarantee they drift apart. Because it is the exception it lives in
its own schema file and says so in its migration, so nobody inherits "no RLS" by copying a
neighbour. Approval is **owner-only**, precisely because it changes what every household in the
install is told about tax law.

The screen distinguishes *never filled in* from *filled in and then unapproved*. The server withholds
an untouched row's value so a placeholder can never render, but sends a figure somebody typed and
later withdrew — wiping that would destroy the thing they were about to re-check. `retrieved_at` is
the discriminator; this was found by walking the flow, not by a test.

`opportunity_states` and the phase B rules engine remain unbuilt. The reference pipeline is their
prerequisite and is now in place.

Social Security is the same shape of problem and gets the same answer: the benefit is **read off an
SSA statement and typed in**, never computed. The formula needs a full indexed wage history that
Beans does not have.

---

## 20. Recurring charges and subscriptions

`/subscriptions` lists charges that repeat on a schedule, in two groups: **subscriptions** (the
amount holds still — Netflix, iCloud, a gym) and **bills** (on a schedule but the amount moves, or
fixed but too large to be what anybody means by a subscription — electricity, rent). It identifies;
it does not cancel anything.

### 20.1 Detection runs in the browser

For the reason cash flow does (§7, §14.2): grouping charges by merchant means reading descriptions,
and descriptions are ciphertext in Postgres. `detectRecurring` is a pure function in
`packages/shared/src/recurring/`, run over the working set, so it is tested with fixed dates and no
database. Nothing about a series is stored on the server. The only server state is a person's
override of one (§20.3).

The working set's default two-year window (§7.2) is enough for an annual charge to appear twice,
which is the minimum. The screen says so rather than letting a missing yearly plan look like an
error.

### 20.2 How a series is found, and the choices that look arbitrary

- **Merchant key.** `merchantKeyFor` strips what varies between charges from one merchant: digits
  (reference, store and phone numbers, dates), processor prefixes (`SQ *`, `TST*`), card boilerplate
  and a trailing state code. Three or more digits make a token a reference. The cut-off is there to
  keep `1password`, `23andme` and `24 hour fitness` intact. The key only needs to be _stable_, not
  pretty. **If this function changes, existing decisions stop matching** the series they were made
  about. They are not lost, just orphaned until somebody decides again.
- **Whole merchant first, then per amount.** Netflix with a price rise is one series, so the whole
  merchant is tried first. `APPLE.COM/BILL` is iCloud, Apple TV and more on different days, and
  `AMAZON` is Prime among a hundred one-off orders. Together they look irregular; split by exact
  amount, each is a clean monthly series. Split series are keyed `merchant@amount`.
- **Cadence** is weekly, two-weekly, monthly, quarterly or yearly. Three quarters of the gaps must fit,
  **and the latest one must**, so the series can be forecast from. Minimum charges: four weekly,
  three otherwise, two yearly.
- **Excluded from detection** are pending, voided and refunded charges, plus anything
  `isExcludedFromCashFlow` excludes. A card payment recurs monthly and is a transfer (§9), not a bill.
  The exclusion is the cash flow function, called, not reimplemented.
- **Subscription or bill.** "Fixed" allows one price change in a short run, or one in five in a
  long one. Fixed and at most **$250 a charge** is a subscription; above that, or in a housing,
  insurance or tax category, it is a bill. Rent is as fixed as Netflix, and listing it as a
  subscription is the most visible way this screen could be wrong. Variable amounts in grocery,
  dining, fuel, shopping or travel categories are dropped rather than called bills: a weekly shop
  has exactly a utility bill's shape.
- **Lapsed** means the next charge is overdue by more than half a period. The screen says that is
  usually a cancellation and sometimes a new card, because it cannot tell which.
- **Signs are not decided here.** Charges arrive negative and every amount and total stays negative
  until display negates it (§3.2).

### 20.3 Decisions — `recurring_decisions`

A row exists only where somebody overrode the detector: subscription, bill, or `ignored`.
`ignored` is sticky for the reason a rejected transfer is (§9). Undo deletes the row and returns
the series to whatever detection concludes.

- **The merchant key is encrypted.** It is derived from payee text, so a list of them is a list of
  who the household pays, like rule match text (§5). That rules out a unique constraint: the
  repository serializes writes per household with an advisory lock, and matches after decrypting.
  The key is in the log redaction list.
- **Each decision carries the `account_id` of the series' latest charge, and every read joins
  `accounts`.** The account is not used for matching. It exists so that hiding a charge on a private
  account does not send that merchant's name to every other member in their next working set (§6.4).
  Tested both ways: invisible to the partner, refused when the partner tries to attach a decision to
  an account they cannot see.
- **Sent whole in the working set**, like categories, so a removed decision needs no tombstone. Sync
  reports a changed set as a flag. Without it the screen would re-read the store only when a
  transaction changed, and a decision made on another device would stay invisible until one did.
