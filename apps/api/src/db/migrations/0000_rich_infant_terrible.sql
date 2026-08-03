CREATE TYPE "public"."account_type" AS ENUM('depository', 'credit', 'loan', 'mortgage', 'investment', 'other_asset', 'other_liability');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('income', 'expense', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('healthy', 'stale', 'error');--> statement-breakpoint
CREATE TYPE "public"."deletion_entity" AS ENUM('account', 'transaction', 'balance_snapshot', 'category', 'category_rule', 'transfer_match', 'connection');--> statement-breakpoint
CREATE TYPE "public"."household_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."import_kind" AS ENUM('transactions', 'balances');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('pending', 'imported', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('staged', 'committed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."rule_match_type" AS ENUM('contains', 'regex');--> statement-breakpoint
CREATE TYPE "public"."snapshot_source" AS ENUM('derived', 'observed', 'imported', 'carried');--> statement-breakpoint
CREATE TYPE "public"."sync_outcome" AS ENUM('success', 'partial', 'error');--> statement-breakpoint
CREATE TYPE "public"."tax_treatment" AS ENUM('taxable', 'traditional', 'roth', 'hsa', 'education', 'none');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('synced', 'manual', 'imported');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('active', 'void');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('proposed', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "household_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" "household_role" DEFAULT 'member' NOT NULL,
	"email" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "household_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "household_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_user_uq" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "household_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "households" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"tab_order" jsonb,
	"theme" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"parent_id" uuid,
	"is_system" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_household_parent_name_uq" UNIQUE NULLS NOT DISTINCT("household_id","parent_id","name"),
	CONSTRAINT "categories_household_slug_uq" UNIQUE("household_id","slug")
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"source_preset" text DEFAULT 'custom' NOT NULL,
	"kind" "import_kind" NOT NULL,
	"status" "import_status" DEFAULT 'staged' NOT NULL,
	"original_filename" "bytea",
	"delimiter" text,
	"mapping" jsonb,
	"row_count" integer DEFAULT 0 NOT NULL,
	"committed_row_count" integer DEFAULT 0 NOT NULL,
	"committed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversible_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"institution_id" uuid,
	"access_url" "bytea" NOT NULL,
	"status" "connection_status" DEFAULT 'healthy' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" "bytea",
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"simplefin_org_domain" text NOT NULL,
	"name" "bytea" NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_household_domain_uq" UNIQUE("household_id","simplefin_org_domain")
);
--> statement-breakpoint
ALTER TABLE "institutions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "sync_outcome",
	"window_start_date" date,
	"window_end_date" date,
	"accounts_seen" integer DEFAULT 0 NOT NULL,
	"transactions_upserted" integer DEFAULT 0 NOT NULL,
	"errors" "bytea",
	"warnings" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"connection_id" uuid,
	"institution_id" uuid,
	"type" "account_type" NOT NULL,
	"type_is_user_set" boolean DEFAULT false NOT NULL,
	"display_name" "bytea",
	"provider_name" "bytea",
	"mask" "bytea",
	"currency" text DEFAULT 'USD' NOT NULL,
	"current_balance" "bytea",
	"available_balance" "bytea",
	"balance_as_of" timestamp with time zone,
	"is_manual" boolean DEFAULT false NOT NULL,
	"is_shared" boolean DEFAULT true NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"tax_treatment" "tax_treatment" DEFAULT 'none' NOT NULL,
	"coverage_start_date" date,
	"import_cutover_date" date,
	"simplefin_account_id" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"balance" "bytea" NOT NULL,
	"source" "snapshot_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_snapshots_account_date_uq" UNIQUE("account_id","as_of_date")
);
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manual_balance_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"balance" "bytea" NOT NULL,
	"note" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_balance_updates_account_date_uq" UNIQUE("account_id","effective_date")
);
--> statement-breakpoint
ALTER TABLE "manual_balance_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"simplefin_id" text,
	"posted_date" date NOT NULL,
	"amount" "bytea" NOT NULL,
	"description" "bytea",
	"payee" "bytea",
	"memo" "bytea",
	"category_id" uuid,
	"pending" boolean DEFAULT false NOT NULL,
	"status" "transaction_status" DEFAULT 'active' NOT NULL,
	"source" "transaction_source" DEFAULT 'synced' NOT NULL,
	"import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "category_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match_description" "bytea",
	"match_type" "rule_match_type" DEFAULT 'contains' NOT NULL,
	"match_amount_min" "bytea",
	"match_amount_max" "bytea",
	"match_account_id" uuid,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "category_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfer_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"from_transaction_id" uuid NOT NULL,
	"to_transaction_id" uuid NOT NULL,
	"pair_key" text NOT NULL,
	"status" "transfer_status" DEFAULT 'proposed' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"confirmed_by_user_id" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_matches_household_pair_uq" UNIQUE("household_id","pair_key")
);
--> statement-breakpoint
ALTER TABLE "transfer_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" "bytea",
	"parsed" "bytea",
	"target_account_id" uuid,
	"status" "import_row_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"result_transaction_id" uuid,
	"match_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletions" ADD CONSTRAINT "deletions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_created_by_user_id_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_accepted_by_user_id_auth_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_user_id_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_user_id_auth_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_balance_updates" ADD CONSTRAINT "manual_balance_updates_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_balance_updates" ADD CONSTRAINT "manual_balance_updates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_match_account_id_accounts_id_fk" FOREIGN KEY ("match_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_matches" ADD CONSTRAINT "transfer_matches_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_matches" ADD CONSTRAINT "transfer_matches_from_transaction_id_transactions_id_fk" FOREIGN KEY ("from_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_matches" ADD CONSTRAINT "transfer_matches_to_transaction_id_transactions_id_fk" FOREIGN KEY ("to_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_matches" ADD CONSTRAINT "transfer_matches_confirmed_by_user_id_auth_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_result_transaction_id_transactions_id_fk" FOREIGN KEY ("result_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_match_transaction_id_transactions_id_fk" FOREIGN KEY ("match_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "deletions_household_deleted_at_idx" ON "deletions" USING btree ("household_id","deleted_at");--> statement-breakpoint
CREATE INDEX "household_invites_household_idx" ON "household_invites" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "household_members_household_idx" ON "household_members" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "categories_household_idx" ON "categories" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "imports_household_idx" ON "imports" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "connections_household_idx" ON "connections" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_started_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_connection_simplefin_uq" ON "accounts" USING btree ("connection_id","simplefin_account_id") WHERE "accounts"."simplefin_account_id" is not null;--> statement-breakpoint
CREATE INDEX "accounts_household_idx" ON "accounts" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "accounts_household_updated_at_idx" ON "accounts" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE INDEX "balance_snapshots_household_date_idx" ON "balance_snapshots" USING btree ("household_id","as_of_date");--> statement-breakpoint
CREATE INDEX "balance_snapshots_household_updated_at_idx" ON "balance_snapshots" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE INDEX "manual_balance_updates_household_idx" ON "manual_balance_updates" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_account_simplefin_uq" ON "transactions" USING btree ("account_id","simplefin_id") WHERE "transactions"."simplefin_id" is not null;--> statement-breakpoint
CREATE INDEX "transactions_household_posted_idx" ON "transactions" USING btree ("household_id","posted_date");--> statement-breakpoint
CREATE INDEX "transactions_account_posted_idx" ON "transactions" USING btree ("account_id","posted_date");--> statement-breakpoint
CREATE INDEX "transactions_category_idx" ON "transactions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transactions_import_idx" ON "transactions" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "transactions_household_updated_at_idx" ON "transactions" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE INDEX "category_rules_household_priority_idx" ON "category_rules" USING btree ("household_id","priority");--> statement-breakpoint
CREATE INDEX "category_rules_household_updated_at_idx" ON "category_rules" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_matches_from_confirmed_uq" ON "transfer_matches" USING btree ("from_transaction_id") WHERE "transfer_matches"."status" = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_matches_to_confirmed_uq" ON "transfer_matches" USING btree ("to_transaction_id") WHERE "transfer_matches"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "transfer_matches_household_updated_at_idx" ON "transfer_matches" USING btree ("household_id","updated_at");--> statement-breakpoint
CREATE INDEX "import_rows_import_idx" ON "import_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_household_idx" ON "import_rows" USING btree ("household_id");--> statement-breakpoint
CREATE POLICY "deletions_household_isolation" ON "deletions" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "household_invites_household_isolation" ON "household_invites" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "household_members_household_isolation" ON "household_members" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "households_self_isolation" ON "households" AS PERMISSIVE FOR ALL TO public USING (id = current_setting('app.current_household', true)::uuid) WITH CHECK (id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "user_preferences_user_isolation" ON "user_preferences" AS PERMISSIVE FOR ALL TO public USING (user_id = current_setting('app.current_user_id', true)) WITH CHECK (user_id = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "categories_household_isolation" ON "categories" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "imports_household_isolation" ON "imports" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "connections_household_isolation" ON "connections" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "institutions_household_isolation" ON "institutions" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "sync_runs_household_isolation" ON "sync_runs" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "accounts_household_isolation" ON "accounts" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "balance_snapshots_household_isolation" ON "balance_snapshots" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "manual_balance_updates_household_isolation" ON "manual_balance_updates" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "transactions_household_isolation" ON "transactions" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "category_rules_household_isolation" ON "category_rules" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "transfer_matches_household_isolation" ON "transfer_matches" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);--> statement-breakpoint
CREATE POLICY "import_rows_household_isolation" ON "import_rows" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.current_household', true)::uuid) WITH CHECK (household_id = current_setting('app.current_household', true)::uuid);