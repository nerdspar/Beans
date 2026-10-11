CREATE TYPE "public"."recurring_decision" AS ENUM('subscription', 'bill', 'ignored');--> statement-breakpoint
CREATE TABLE "recurring_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"merchant_key" "bytea" NOT NULL,
	"decision" "recurring_decision" NOT NULL,
	"account_id" uuid NOT NULL,
	"decided_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recurring_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_decisions" ADD CONSTRAINT "recurring_decisions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_decisions" ADD CONSTRAINT "recurring_decisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_decisions" ADD CONSTRAINT "recurring_decisions_decided_by_user_id_auth_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_decisions_household_updated_at_idx" ON "recurring_decisions" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE INDEX "recurring_decisions_account_idx" ON "recurring_decisions" USING btree ("account_id");--> statement-breakpoint
CREATE POLICY "recurring_decisions_household_isolation" ON "recurring_decisions" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
-- FORCE, because ENABLE alone is decorative for the role that owns the table, and migrations create
-- it. Drizzle emits ENABLE and never FORCE; see 0002_force_rls.sql for the long version.
--> statement-breakpoint
ALTER TABLE "recurring_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The cursor column, maintained by the database rather than application code, added in the same
-- migration as the table per CLAUDE.md.
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_recurring_decisions ON recurring_decisions;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_recurring_decisions
  BEFORE UPDATE ON recurring_decisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
