CREATE TYPE "public"."reference_unit" AS ENUM('cents', 'years', 'basis_points');--> statement-breakpoint
CREATE TABLE "contribution_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_year" integer NOT NULL,
	"key" text NOT NULL,
	"value" bigint NOT NULL,
	"unit" "reference_unit" NOT NULL,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_limits_year_key_uq" UNIQUE("tax_year","key")
);
--> statement-breakpoint
-- No RLS here, and no household_id, deliberately.
--
-- Every other table in this schema is tenant data and gets both. This one holds figures the IRS
-- publishes: the same for every household in the world, personal to nobody, and derived from
-- nobody's data. Scoping it to a tenant would mean one copy per household and a guarantee they
-- drift apart.
--
-- It is the exception, so it is called out here rather than left to be inferred from its absence.
--> statement-breakpoint
-- The delta-sync cursor trigger, as every table carrying updated_at needs (CLAUDE.md).
DROP TRIGGER IF EXISTS set_updated_at_contribution_limits ON contribution_limits;
--> statement-breakpoint
CREATE TRIGGER set_updated_at_contribution_limits
  BEFORE UPDATE ON contribution_limits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
