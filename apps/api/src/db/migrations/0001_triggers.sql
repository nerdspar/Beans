-- Triggers. Drizzle has no trigger API, so these are hand-written and drizzle-kit never
-- introspects or drops them. Everything below uses CREATE OR REPLACE / DROP IF EXISTS so that
-- re-running is safe.

--------------------------------------------------------------------------------
-- updated_at: the delta-sync cursor
--------------------------------------------------------------------------------
-- Maintained by the database, not by application code, on purpose (ARCHITECTURE.md §7.3).
-- One forgotten write path would silently desynchronize every client, and the symptom would be
-- missing data on their side rather than an error on ours.
--
-- This matters most for balance_snapshots: backward reconstruction rewrites history whenever a
-- late transaction posts, so rows change without anything being inserted. A client syncing on
-- "what's new" alone would never see the correction.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Applied to every table carrying updated_at. The auth_* tables are deliberately excluded:
-- Better Auth maintains its own timestamps and they are not part of household delta sync.
--
-- If you add a client-cached table, add its trigger here in the same migration as the column.

DO $$
DECLARE
  target text;
  targets text[] := ARRAY[
    'households',
    'household_members',
    'household_invites',
    'user_preferences',
    'institutions',
    'connections',
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
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'set_updated_at_' || target, target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'set_updated_at_' || target,
      target
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- Categories: at most two levels
--------------------------------------------------------------------------------
-- A category with a parent may not itself be a parent.
--
-- This cannot be a CHECK constraint, because it requires looking at another row. It is enforced
-- here *and* as a repository invariant — belt and braces, because unconstrained self-reference
-- makes rollups ambiguous, forces every UI to handle arbitrary depth, and is effectively
-- unfixable once real data exists (ARCHITECTURE.md §8).
--
-- Both directions are checked. Guarding only the first would leave the second reachable by
-- updating an existing parent rather than inserting a child.

CREATE OR REPLACE FUNCTION enforce_category_depth() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'Category % cannot be its own parent', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Direction 1: the chosen parent must itself be top-level.
  IF EXISTS (
    SELECT 1 FROM categories WHERE id = NEW.parent_id AND parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Categories nest at most two levels: parent % already has a parent', NEW.parent_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Direction 2: a category that already has children cannot be given a parent.
  IF EXISTS (
    SELECT 1 FROM categories WHERE parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Categories nest at most two levels: % already has children', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS enforce_category_depth ON categories;
--> statement-breakpoint

CREATE TRIGGER enforce_category_depth
  BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION enforce_category_depth();
--> statement-breakpoint

--------------------------------------------------------------------------------
-- System categories: the slug is immutable
--------------------------------------------------------------------------------
-- Rules and CSV import presets reference the slug, never the display label, precisely so a user
-- can rename "Groceries" to "Food" without breaking anything. That guarantee only holds if the
-- slug cannot move underneath them.

CREATE OR REPLACE FUNCTION enforce_system_category_slug() RETURNS trigger AS $$
BEGIN
  IF OLD.is_system AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'System category slug % is immutable; rename the display label instead', OLD.slug
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS enforce_system_category_slug ON categories;
--> statement-breakpoint

CREATE TRIGGER enforce_system_category_slug
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION enforce_system_category_slug();
