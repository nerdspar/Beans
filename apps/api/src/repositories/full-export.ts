import { centsToDecimalString } from '@beans/shared'
import type { HouseholdContext } from './household-context.js'

/**
 * Everything a household has, in one document, for the move to the native app.
 *
 * The CSV exports (`export.ts`) are for people leaving Beans for something else; this one is for
 * Beans leaving the server. It carries what the CSVs flatten away — ids, so a re-run import writes
 * the same records instead of duplicates; decisions (categories, rules, transfers, recurring);
 * retirement; and which balances were observed rather than derived — because the native app
 * rebuilds derived history itself and must not mistake its old output for an input.
 *
 * Three rules, each one a way this could leak or lie:
 * - **Every account-scoped read inner-joins `accounts`.** Account visibility (§6.4) is what keeps a
 *   member's private account from another member, and child tables are isolated by household
 *   alone. A query here that read transactions without that join would export someone else's
 *   private account.
 * - **The SimpleFIN access URL is never included**, not even partially (§10). The native app
 *   reconnects with a new setup token and re-matches accounts by `simplefin_account_id`.
 * - **Money is a decimal string**, never a JSON number (§3).
 */

export const FULL_EXPORT_VERSION = 1

type Column = 'plain' | 'text' | 'money' | 'json' | 'date' | 'timestamp'
type Spec = Record<string, Column>

function decode(
  context: HouseholdContext,
  spec: Spec,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [column, kind] of Object.entries(spec)) {
    const value = row[column]
    const key = column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    if (value === null || value === undefined) {
      out[key] = null
      continue
    }
    switch (kind) {
      case 'plain':
        out[key] = value
        break
      case 'text':
        out[key] = context.cipher.decryptText(value as Buffer)
        break
      case 'money':
        out[key] = centsToDecimalString(context.cipher.decryptMoney(value as Buffer))
        break
      case 'json':
        out[key] = context.cipher.decryptJson(value as Buffer)
        break
      case 'date':
        // `date` columns arrive as text from the pg type parser this app configures; keep them so.
        out[key] = typeof value === 'string' ? value : (value as Date).toISOString().slice(0, 10)
        break
      case 'timestamp':
        out[key] = value instanceof Date ? value.toISOString() : String(value)
        break
    }
  }
  return out
}

async function rows(
  context: HouseholdContext,
  sql: string,
  spec: Spec,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await context.client.query<Record<string, unknown>>(sql, params)
  return result.rows.map((row) => decode(context, spec, row))
}

export type FullExport = Record<string, unknown> & { version: number }

export async function exportEverything(context: HouseholdContext): Promise<FullExport> {
  const household = await rows(
    context,
    `select id, name, trust_imported_history from households where id = $1`,
    { id: 'plain', name: 'plain', trust_imported_history: 'plain' },
    [context.householdId],
  )

  const accounts = await rows(
    context,
    `select a.id, a.connection_id, a.type, a.type_is_user_set, a.display_name, a.provider_name, a.mask,
            a.currency, a.current_balance, a.available_balance, a.balance_as_of, a.is_manual, a.is_shared,
            a.owner_user_id = $1 as owned_by_me, a.is_closed, a.closed_on, a.payoff_date, a.tax_treatment,
            a.coverage_start_date, a.import_cutover_date, a.simplefin_account_id, a.holdings_checked_at,
            a.provider_sign_inverted, a.confirmed_at, a.created_at, a.updated_at,
            i.name as institution_name, i.simplefin_org_domain as institution_domain
       from accounts a
       left join institutions i on i.id = a.institution_id
      order by a.created_at, a.id`,
    {
      id: 'plain',
      connection_id: 'plain',
      type: 'plain',
      type_is_user_set: 'plain',
      display_name: 'text',
      provider_name: 'text',
      mask: 'text',
      currency: 'plain',
      current_balance: 'money',
      available_balance: 'money',
      balance_as_of: 'timestamp',
      is_manual: 'plain',
      is_shared: 'plain',
      owned_by_me: 'plain',
      is_closed: 'plain',
      closed_on: 'date',
      payoff_date: 'date',
      tax_treatment: 'plain',
      coverage_start_date: 'date',
      import_cutover_date: 'date',
      simplefin_account_id: 'plain',
      holdings_checked_at: 'timestamp',
      provider_sign_inverted: 'plain',
      confirmed_at: 'timestamp',
      created_at: 'timestamp',
      updated_at: 'timestamp',
      institution_name: 'text',
      institution_domain: 'plain',
    },
    [context.userId],
  )

  const transactions = await rows(
    context,
    `select t.id, t.account_id, t.simplefin_id, t.posted_date, t.amount, t.description, t.payee, t.memo,
            t.category_id, t.pending, t.status, t.source, t.import_id, t.created_at, t.updated_at
       from transactions t
       join accounts a on a.id = t.account_id
      order by t.posted_date, t.id`,
    {
      id: 'plain',
      account_id: 'plain',
      simplefin_id: 'plain',
      posted_date: 'date',
      amount: 'money',
      description: 'text',
      payee: 'text',
      memo: 'text',
      category_id: 'plain',
      pending: 'plain',
      status: 'plain',
      source: 'plain',
      import_id: 'plain',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
  )

  // Only what was observed or imported: derived and carried rows are the server's own output and
  // the native app rebuilds them.
  const balanceSnapshots = await rows(
    context,
    `select b.account_id, b.as_of_date, b.balance, b.source, b.import_id
       from balance_snapshots b
       join accounts a on a.id = b.account_id
      where b.source in ('observed', 'imported')
      order by b.account_id, b.as_of_date`,
    {
      account_id: 'plain',
      as_of_date: 'date',
      balance: 'money',
      source: 'plain',
      import_id: 'plain',
    },
  )

  const balanceReadings = await rows(
    context,
    `select r.id, r.account_id, r.as_of_date, r.balance
       from balance_readings r
       join accounts a on a.id = r.account_id
      order by r.account_id, r.as_of_date`,
    { id: 'plain', account_id: 'plain', as_of_date: 'date', balance: 'money' },
  )

  const manualBalanceUpdates = await rows(
    context,
    `select m.id, m.account_id, m.effective_date, m.balance, m.note, m.created_at
       from manual_balance_updates m
       join accounts a on a.id = m.account_id
      order by m.account_id, m.effective_date`,
    {
      id: 'plain',
      account_id: 'plain',
      effective_date: 'date',
      balance: 'money',
      note: 'text',
      created_at: 'timestamp',
    },
  )

  const holdings = await rows(
    context,
    `select h.id, h.account_id, h.as_of_date, h.provider_holding_id, h.symbol, h.description, h.shares,
            h.market_value, h.cost_basis, h.purchase_price, h.currency
       from holdings h
       join accounts a on a.id = h.account_id
      order by h.account_id, h.as_of_date, h.provider_holding_id`,
    {
      id: 'plain',
      account_id: 'plain',
      as_of_date: 'date',
      provider_holding_id: 'plain',
      symbol: 'text',
      description: 'text',
      shares: 'text',
      market_value: 'money',
      cost_basis: 'money',
      purchase_price: 'money',
      currency: 'plain',
    },
  )

  const categories = await rows(
    context,
    `select id, slug, name, kind, parent_id, is_system, sort_order, archived from categories order by sort_order, id`,
    {
      id: 'plain',
      slug: 'plain',
      name: 'plain',
      kind: 'plain',
      parent_id: 'plain',
      is_system: 'plain',
      sort_order: 'plain',
      archived: 'plain',
    },
  )

  const ruleRows = await context.client.query<Record<string, unknown>>(
    `select r.id, r.priority, r.enabled, r.match_description, r.match_keywords, r.keyword_mode, r.match_type,
            r.match_amount_min, r.match_amount_max, r.match_account_id, r.category_id, r.created_at
       from category_rules r
       left join accounts a on a.id = r.match_account_id
      where r.match_account_id is null or a.id is not null
      order by r.priority, r.created_at`,
  )
  const categoryRules = ruleRows.rows.map((row) => ({
    ...decode(
      context,
      {
        id: 'plain',
        priority: 'plain',
        enabled: 'plain',
        keyword_mode: 'plain',
        match_type: 'plain',
        match_amount_min: 'money',
        match_amount_max: 'money',
        match_account_id: 'plain',
        category_id: 'plain',
        created_at: 'timestamp',
      },
      row,
    ),
    // Legacy single-term rules folded in, as `listRules` does.
    keywords:
      row['match_keywords'] !== null
        ? context.cipher.decryptJson<string[]>(row['match_keywords'] as Buffer)
        : row['match_description'] !== null
          ? [context.cipher.decryptText(row['match_description'] as Buffer)]
          : [],
  }))

  // Both sides must be visible: a match naming a private account's transaction discloses it (§6.4).
  const transferMatches = await rows(
    context,
    `select m.id, m.from_transaction_id, m.to_transaction_id, m.pair_key, m.status, m.confidence, m.confirmed_at
       from transfer_matches m
       join transactions f on f.id = m.from_transaction_id
       join accounts fa on fa.id = f.account_id
       join transactions t on t.id = m.to_transaction_id
       join accounts ta on ta.id = t.account_id
      order by m.id`,
    {
      id: 'plain',
      from_transaction_id: 'plain',
      to_transaction_id: 'plain',
      pair_key: 'plain',
      status: 'plain',
      confidence: 'plain',
      confirmed_at: 'timestamp',
    },
  )

  const recurringDecisions = await rows(
    context,
    `select d.id, d.merchant_key, d.decision, d.account_id, d.updated_at
       from recurring_decisions d
       join accounts a on a.id = d.account_id
      order by d.id`,
    {
      id: 'plain',
      merchant_key: 'text',
      decision: 'plain',
      account_id: 'plain',
      updated_at: 'timestamp',
    },
  )

  const imports = await rows(
    context,
    `select id, source_preset, kind, status, original_filename, delimiter, row_count, committed_row_count,
            committed_at, reversed_at, reversible_until, created_at
       from imports order by created_at`,
    {
      id: 'plain',
      source_preset: 'plain',
      kind: 'plain',
      status: 'plain',
      original_filename: 'text',
      delimiter: 'plain',
      row_count: 'plain',
      committed_row_count: 'plain',
      committed_at: 'timestamp',
      reversed_at: 'timestamp',
      reversible_until: 'timestamp',
      created_at: 'timestamp',
    },
  )

  const retirementProfiles = await rows(
    context,
    `select id, retirement_effective_rate_basis_points, withdrawal_order, pre65_healthcare_annual_amount
       from retirement_profiles`,
    {
      id: 'plain',
      retirement_effective_rate_basis_points: 'plain',
      withdrawal_order: 'plain',
      pre65_healthcare_annual_amount: 'money',
    },
  )
  const retirementMembers = await rows(
    context,
    `select id, display_name, user_id = $1 as is_me, birth_year, target_retirement_date, social_security_claim_age,
            social_security_annual_benefit, life_expectancy
       from retirement_members order by created_at`,
    {
      id: 'plain',
      display_name: 'text',
      is_me: 'plain',
      birth_year: 'plain',
      target_retirement_date: 'date',
      social_security_claim_age: 'plain',
      social_security_annual_benefit: 'money',
      life_expectancy: 'plain',
    },
    [context.userId],
  )
  const retirementSpending = await rows(
    context,
    `select id, category_id, treatment, adjustment_basis_points, last_year, reviewed_at from retirement_spending_assumptions`,
    {
      id: 'plain',
      category_id: 'plain',
      treatment: 'plain',
      adjustment_basis_points: 'plain',
      last_year: 'plain',
      reviewed_at: 'timestamp',
    },
  )
  const retirementScenarios = await rows(
    context,
    `select id, name, pre_retirement_return_basis_points, post_retirement_return_basis_points, annual_spending_override,
            retirement_years_offset, is_default, sort_order
       from retirement_scenarios order by sort_order, id`,
    {
      id: 'plain',
      name: 'plain',
      pre_retirement_return_basis_points: 'plain',
      post_retirement_return_basis_points: 'plain',
      annual_spending_override: 'money',
      retirement_years_offset: 'plain',
      is_default: 'plain',
      sort_order: 'plain',
    },
  )
  const accountTaxBuckets = await rows(
    context,
    `select b.id, b.account_id, b.treatment, b.balance, b.as_of_date
       from account_tax_buckets b join accounts a on a.id = b.account_id order by b.account_id, b.as_of_date`,
    { id: 'plain', account_id: 'plain', treatment: 'plain', balance: 'money', as_of_date: 'date' },
  )
  const contributionRouting = await rows(
    context,
    `select r.id, r.account_id, r.treatment, r.annual_amount, r.active
       from account_contribution_routing r join accounts a on a.id = r.account_id order by r.account_id`,
    {
      id: 'plain',
      account_id: 'plain',
      treatment: 'plain',
      annual_amount: 'money',
      active: 'plain',
    },
  )
  const planFeatures = await rows(
    context,
    `select f.id, f.account_id, f.is_employer_plan, f.allows_after_tax_contributions, f.allows_in_plan_roth_conversion,
            f.allows_in_service_withdrawal, f.accepts_ira_roll_ins, f.employer_match_description, f.answered_at
       from plan_features f join accounts a on a.id = f.account_id order by f.account_id`,
    {
      id: 'plain',
      account_id: 'plain',
      is_employer_plan: 'plain',
      allows_after_tax_contributions: 'plain',
      allows_in_plan_roth_conversion: 'plain',
      allows_in_service_withdrawal: 'plain',
      accepts_ira_roll_ins: 'plain',
      employer_match_description: 'text',
      answered_at: 'timestamp',
    },
  )

  // Statutory figures are global, not household data; they travel so the approvals do too.
  const referenceFigures = await rows(
    context,
    `select tax_year, key, value::text as value, unit, source_url, retrieved_at, verified_at, verified_by
       from contribution_limits order by tax_year, key`,
    {
      tax_year: 'plain',
      key: 'plain',
      value: 'plain',
      unit: 'plain',
      source_url: 'plain',
      retrieved_at: 'timestamp',
      verified_at: 'timestamp',
      verified_by: 'plain',
    },
  )

  // Yours only, and never the credential.
  const connections = await rows(
    context,
    `select c.id, c.status, c.last_success_at, c.last_attempt_at, c.consecutive_failures, c.created_at,
            i.name as institution_name
       from connections c
       left join institutions i on i.id = c.institution_id
      where c.owner_user_id = $1
      order by c.created_at`,
    {
      id: 'plain',
      status: 'plain',
      last_success_at: 'timestamp',
      last_attempt_at: 'timestamp',
      consecutive_failures: 'plain',
      created_at: 'timestamp',
      institution_name: 'text',
    },
    [context.userId],
  )

  const preferences = await rows(
    context,
    `select tab_order, theme, show_incomplete_history from user_preferences where user_id = $1`,
    { tab_order: 'plain', theme: 'plain', show_incomplete_history: 'plain' },
    [context.userId],
  )

  return {
    version: FULL_EXPORT_VERSION,
    householdId: context.householdId,
    role: context.role,
    household: household[0] ?? null,
    preferences: preferences[0] ?? null,
    accounts,
    transactions,
    balanceSnapshots,
    balanceReadings,
    manualBalanceUpdates,
    holdings,
    categories,
    categoryRules,
    transferMatches,
    recurringDecisions,
    imports,
    retirement: {
      profile: retirementProfiles[0] ?? null,
      members: retirementMembers,
      spending: retirementSpending,
      scenarios: retirementScenarios,
      taxBuckets: accountTaxBuckets,
      contributionRouting,
      planFeatures,
    },
    referenceFigures,
    connections,
  }
}
