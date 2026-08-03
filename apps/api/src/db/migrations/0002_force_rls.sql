-- FORCE ROW LEVEL SECURITY.
--
-- This migration is the difference between our RLS policies being enforced and being decorative.
--
-- Postgres exempts a table's OWNER from row-level security by default. Migrations create these
-- tables, so whichever role runs them owns them — and every policy in migration 0000 would be
-- silently skipped for that role. No error, no warning, no symptom until someone reads another
-- household's data. FORCE removes the owner exemption.
--
-- Two things are still required of the deployment and cannot be enforced from here:
--   1. The application role must not be SUPERUSER. Superusers bypass RLS even with FORCE.
--   2. The application role must not have BYPASSRLS.
-- Both are set up in docker/initdb/01-init.sh, and asserted by the tenant isolation tests.
--
-- The auth_* tables are excluded deliberately: identity is cross-household by nature and they
-- carry no household_id (ARCHITECTURE.md §6.1).

DO $$
DECLARE
  target text;
  targets text[] := ARRAY[
    'households',
    'household_members',
    'household_invites',
    'user_preferences',
    'deletions',
    'institutions',
    'connections',
    'sync_runs',
    'accounts',
    'transactions',
    'balance_snapshots',
    'manual_balance_updates',
    'categories',
    'category_rules',
    'transfer_matches',
    'imports',
    'import_rows'
  ];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END;
$$;
