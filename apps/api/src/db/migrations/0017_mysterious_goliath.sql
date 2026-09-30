CREATE TYPE "public"."spending_treatment" AS ENUM('continues', 'stops', 'adjusted');--> statement-breakpoint
ALTER TYPE "public"."tax_treatment" ADD VALUE 'after_tax' BEFORE 'hsa';--> statement-breakpoint
CREATE TABLE "account_contribution_routing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"treatment" "tax_treatment" NOT NULL,
	"annual_amount" "bytea" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_contribution_routing_account_treatment_uq" UNIQUE("account_id","treatment")
);
--> statement-breakpoint
ALTER TABLE "account_contribution_routing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account_tax_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"treatment" "tax_treatment" NOT NULL,
	"balance" "bytea" NOT NULL,
	"as_of_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_tax_buckets_account_treatment_date_uq" UNIQUE("account_id","treatment","as_of_date")
);
--> statement-breakpoint
ALTER TABLE "account_tax_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"allows_after_tax_contributions" boolean,
	"allows_in_plan_roth_conversion" boolean,
	"allows_in_service_withdrawal" boolean,
	"accepts_ira_roll_ins" boolean,
	"employer_match_description" "bytea",
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_features_account_uq" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "plan_features" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inputs" "bytea" NOT NULL,
	"results" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projection_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retirement_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"display_name" "bytea" NOT NULL,
	"user_id" text,
	"birth_year" integer NOT NULL,
	"target_retirement_date" date,
	"social_security_claim_age" integer,
	"social_security_annual_benefit" "bytea",
	"life_expectancy" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retirement_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retirement_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"retirement_effective_rate_basis_points" integer DEFAULT 2200 NOT NULL,
	"withdrawal_order" jsonb,
	"pre65_healthcare_annual_amount" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_profiles_household_uq" UNIQUE("household_id")
);
--> statement-breakpoint
ALTER TABLE "retirement_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retirement_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pre_retirement_return_basis_points" integer NOT NULL,
	"post_retirement_return_basis_points" integer NOT NULL,
	"annual_spending_override" "bytea",
	"retirement_years_offset" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_scenarios_profile_name_uq" UNIQUE("profile_id","name")
);
--> statement-breakpoint
ALTER TABLE "retirement_scenarios" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retirement_spending_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"treatment" "spending_treatment" NOT NULL,
	"adjustment_basis_points" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_spending_assumptions_profile_category_uq" UNIQUE("profile_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "retirement_spending_assumptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "payoff_date" date;--> statement-breakpoint
ALTER TABLE "account_contribution_routing" ADD CONSTRAINT "account_contribution_routing_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contribution_routing" ADD CONSTRAINT "account_contribution_routing_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_tax_buckets" ADD CONSTRAINT "account_tax_buckets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_tax_buckets" ADD CONSTRAINT "account_tax_buckets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_runs" ADD CONSTRAINT "projection_runs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection_runs" ADD CONSTRAINT "projection_runs_profile_id_retirement_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."retirement_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_members" ADD CONSTRAINT "retirement_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_members" ADD CONSTRAINT "retirement_members_profile_id_retirement_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."retirement_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_members" ADD CONSTRAINT "retirement_members_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_profiles" ADD CONSTRAINT "retirement_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_scenarios" ADD CONSTRAINT "retirement_scenarios_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_scenarios" ADD CONSTRAINT "retirement_scenarios_profile_id_retirement_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."retirement_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_spending_assumptions" ADD CONSTRAINT "retirement_spending_assumptions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_spending_assumptions" ADD CONSTRAINT "retirement_spending_assumptions_profile_id_retirement_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."retirement_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retirement_spending_assumptions" ADD CONSTRAINT "retirement_spending_assumptions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_contribution_routing_account_idx" ON "account_contribution_routing" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_tax_buckets_account_date_idx" ON "account_tax_buckets" USING btree ("account_id","as_of_date");--> statement-breakpoint
CREATE INDEX "projection_runs_household_run_at_idx" ON "projection_runs" USING btree ("household_id","run_at");--> statement-breakpoint
CREATE INDEX "projection_runs_profile_run_at_idx" ON "projection_runs" USING btree ("profile_id","run_at");--> statement-breakpoint
CREATE INDEX "retirement_members_profile_idx" ON "retirement_members" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retirement_scenarios_profile_default_uq" ON "retirement_scenarios" USING btree ("profile_id") WHERE "retirement_scenarios"."is_default";--> statement-breakpoint
CREATE INDEX "retirement_scenarios_profile_idx" ON "retirement_scenarios" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "retirement_spending_assumptions_profile_idx" ON "retirement_spending_assumptions" USING btree ("profile_id");--> statement-breakpoint
CREATE POLICY "account_contribution_routing_household_isolation" ON "account_contribution_routing" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "account_tax_buckets_household_isolation" ON "account_tax_buckets" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "plan_features_household_isolation" ON "plan_features" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projection_runs_household_isolation" ON "projection_runs" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "retirement_members_household_isolation" ON "retirement_members" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "retirement_profiles_household_isolation" ON "retirement_profiles" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "retirement_scenarios_household_isolation" ON "retirement_scenarios" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "retirement_spending_assumptions_household_isolation" ON "retirement_spending_assumptions" AS PERMISSIVE FOR ALL TO public USING (household_id = nullif(current_setting('app.current_household', true), '')::uuid) WITH CHECK (household_id = nullif(current_setting('app.current_household', true), '')::uuid);
--> statement-breakpoint
-- FORCE, on every table above. ENABLE alone is decorative for whichever role owns the table, and
-- migrations create them, so that is the role running this. Drizzle emits ENABLE and never FORCE;
-- see 0002_force_rls.sql for the long version.
--
-- Nothing here is loud when it is missing. There is no error and no symptom until one household
-- reads another household's retirement plan.
--> statement-breakpoint
ALTER TABLE "account_contribution_routing" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "account_tax_buckets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_features" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projection_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "retirement_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "retirement_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "retirement_scenarios" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "retirement_spending_assumptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The delta-sync cursor, maintained by the database rather than application code, added in the same
-- migration as the column per CLAUDE.md.
--
-- projection_runs is deliberately absent: it carries created_at and no updated_at, because a run is
-- written once and never touched. A trigger there would be dead code guarding a column that does
-- not exist.
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_account_contribution_routing ON account_contribution_routing;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_account_contribution_routing
  BEFORE UPDATE ON account_contribution_routing
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_account_tax_buckets ON account_tax_buckets;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_account_tax_buckets
  BEFORE UPDATE ON account_tax_buckets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_plan_features ON plan_features;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_plan_features
  BEFORE UPDATE ON plan_features
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_retirement_members ON retirement_members;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_retirement_members
  BEFORE UPDATE ON retirement_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_retirement_profiles ON retirement_profiles;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_retirement_profiles
  BEFORE UPDATE ON retirement_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_retirement_scenarios ON retirement_scenarios;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_retirement_scenarios
  BEFORE UPDATE ON retirement_scenarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at_retirement_spending_assumptions ON retirement_spending_assumptions;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_retirement_spending_assumptions
  BEFORE UPDATE ON retirement_spending_assumptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
