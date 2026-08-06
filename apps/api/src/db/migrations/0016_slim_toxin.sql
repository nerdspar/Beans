CREATE TABLE "balance_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"balance" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_readings_account_date_uq" UNIQUE("account_id","as_of_date")
);
--> statement-breakpoint
ALTER TABLE "balance_readings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "balance_readings" ADD CONSTRAINT "balance_readings_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_readings" ADD CONSTRAINT "balance_readings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_readings_account_date_idx" ON "balance_readings" USING btree ("account_id","as_of_date");--> statement-breakpoint
CREATE POLICY "balance_readings_household_isolation" ON "balance_readings" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);
--> statement-breakpoint
-- FORCE, because ENABLE alone is decorative for whichever role owns the table — and migrations
-- create it, so that is the role running this. Drizzle emits ENABLE and never FORCE; see
-- 0002_force_rls.sql, which says the same thing at more length and is the reason this line exists.
--
-- Missing it produces no error and no symptom until somebody reads another household's readings.
ALTER TABLE "balance_readings" FORCE ROW LEVEL SECURITY;
