CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"provider_holding_id" text NOT NULL,
	"symbol" "bytea",
	"description" "bytea",
	"shares" "bytea",
	"market_value" "bytea" NOT NULL,
	"cost_basis" "bytea",
	"purchase_price" "bytea",
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_account_holding_date_uq" UNIQUE("account_id","provider_holding_id","as_of_date")
);
--> statement-breakpoint
ALTER TABLE "holdings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holdings_account_date_idx" ON "holdings" USING btree ("account_id","as_of_date");--> statement-breakpoint
CREATE INDEX "holdings_household_updated_at_idx" ON "holdings" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE POLICY "holdings_household_isolation" ON "holdings" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint

-- FORCE, not merely ENABLE.
--
-- Drizzle emits ENABLE ROW LEVEL SECURITY and the policy above, and stops there. Postgres exempts a
-- table's OWNER from row-level security, and migrations create these tables — so without this line
-- the policy is decorative for the role that ran them, with no error and no symptom until one
-- household reads another's positions. Same reasoning as migration 0002; repeated because every new
-- table needs it and the generated SQL will never contain it.
ALTER TABLE "holdings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The delta-sync cursor, maintained by the database rather than application code.
--
-- Required of every table carrying updated_at, added in the same migration as the column per
-- CLAUDE.md. A holding row is updated in place when a re-sync restates the same position on the
-- same date, so rows change without anything being inserted.
DROP TRIGGER IF EXISTS set_updated_at_holdings ON holdings;--> statement-breakpoint
CREATE TRIGGER set_updated_at_holdings
  BEFORE UPDATE ON holdings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
