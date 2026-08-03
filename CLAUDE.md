# Beans — conventions

Read `ARCHITECTURE.md` first for decisions and their reasoning. This file is the day-to-day
how-we-write-code companion to it.

## Repo

pnpm workspaces monorepo. Node 22, pnpm 11.

```
apps/api        Fastify + Drizzle. Sync worker (pg-boss) runs in-process, isolated in src/worker/.
apps/web        React 18 + Vite + Tailwind + shadcn/ui + TanStack Query.
packages/shared Types, zod schemas, money, category defaults, and the user-facing copy catalog.
                Imported by BOTH api and web — keep it dependency-light and runtime-agnostic.
docker/         Multi-stage Dockerfile, compose, master key secret.
```

Anything the API and the web app must agree on goes in `packages/shared`. If only one uses it, it
does not go there.

## TypeScript

- `strict: true` everywhere. No exceptions.
- **No `any` without a comment on the same line explaining why.** `unknown` plus narrowing is almost
  always the right answer instead.
- Prefer `type` for data shapes, `interface` only when declaration merging is actually wanted.
- Exported functions get explicit return types. Inference is fine internally.

## Money — the rules that silently corrupt data if broken

- Money is **`bigint` cents** in the domain. Never `number`, never float, never `numeric`.
- **Never `parseFloat` on a money string.** Use the parser in `packages/shared/src/money/`.
- Money crosses the API boundary as a **decimal string**, never a JSON number — JSON numbers are
  IEEE-754 doubles and will silently lose precision above 2^53.
- Amounts are signed so they **add directly to net worth** (assets/income positive, liabilities/
  spending negative). Normalization happens once, at the ingest edge. Never re-decide a sign in a
  component, query, or view.
- **Assets vs liabilities is decided by `accounts.type`, never by the sign of a balance.** An
  overdrawn checking account is still a cash asset.
- Transaction dates are `date`. Sync timestamps and audit fields are `timestamptz`. Do not mix them.

## Database

- Drizzle. Schema lives in `apps/api/src/db/schema/`, migrations generated to `apps/api/src/db/migrations/`.
- **Migrations are committed and never edited after being applied.** Fix forward with a new one.
- Every tenant table carries `household_id` (denormalized deliberately — RLS and indexing need it).
- Every client-cached table carries `updated_at`, maintained by a **trigger**, not application code.
  If you add such a table, add the trigger in the same migration.
- Encrypted columns are `bytea`. They cannot be summed, sorted, or range-filtered in SQL. Do not add
  plaintext shadow columns to work around this — see ARCHITECTURE.md §3.1 and §7.
- RLS policies and triggers are hand-written SQL inside migration files; Drizzle does not express them.
- The app connects as a **non-superuser, non-`BYPASSRLS`** role. RLS is silently bypassed otherwise.

## Repositories

- **Every data function takes a household context.** There is no way to query without one. This is
  isolation layer 1; RLS is layer 2. Both are required.
- Repositories return domain types, not raw rows. Decryption happens at that boundary.
- No SQL outside `apps/api/src/repositories/` and migrations.

## Naming

Plain descriptive names. **Beans is the only themed name in the codebase.** No jars, pods, pots,
sprouts, or counters — not in tables, modules, services, functions, or variables.

- Files and directories: `kebab-case`
- Tables and columns: `snake_case`, tables plural (`transactions`, `balance_snapshots`)
- TypeScript: `camelCase` values, `PascalCase` types

## User-facing copy

**All user-facing strings live in `packages/shared/src/copy/`.** Not inline in components. The point
is that the voice is reviewable in one place.

Personality is confined to **empty, loading, error, and confirmation** states. Headers, buttons,
labels, and anything a user navigates by stay plain and legible.

**Beans is never funny about a number moving the wrong way.** No jokes when net worth drops, a
balance goes negative, spending exceeds income, or a card is maxed. Losing money is not a bit. In
those moments copy is calm, factual, and gets out of the way. This is not negotiable and it is worth
failing a review over.

## Frontend

- Two shells: `apps/web/src/shells/mobile/` and `shells/desktop/`, picked once at a breakpoint.
  **Do not write one component tree littered with breakpoint conditionals.** Shared data logic,
  hooks and formatting live outside both.
- Chart code goes behind the wrapper in `apps/web/src/charts/`. No direct Recharts imports elsewhere.
- Server state is TanStack Query. IndexedDB is the only _persistent_ cache — no persister plugin on
  top, no second TTL.
- Every chart needs a table fallback. Everything needs labels and real focus management.

## Logging

Structured JSON. **Amounts, names, tokens, keys, access URLs and DEKs never reach the logs.** Add new
sensitive fields to the redaction list in the same commit that introduces them.

## Tests

- Write them alongside the feature, not at the end.
- **Never `new Date()` in a test.** Fixtures use fixed dates, always.
- Unit tests run against no database. Integration tests run against real Postgres — never a mock,
  never SQLite.
- `pnpm test:math` must stay fast (seconds) and cover parsing, reconstruction, aggregation, transfers.
- Cross-tenant isolation tests are the most important tests here. Do not weaken them to make an
  unrelated refactor pass.

## Commands

```bash
pnpm dev            # api + web
pnpm test           # everything
pnpm test:math      # critical money path only, no DB, fast
pnpm test:integration
pnpm db:generate    # generate migration from schema changes
pnpm db:migrate     # apply migrations
pnpm typecheck
pnpm lint
```

## Before you finish

- Does it have tests?
- Did an encrypted column get summed or sorted in SQL?
- Did a sign get decided outside the ingest edge?
- Did user-facing copy get written inline instead of in the copy module?
- Is `ARCHITECTURE.md` still accurate? If a decision changed, update it **with the reasoning**.
