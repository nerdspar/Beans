CREATE TYPE "public"."keyword_mode" AS ENUM('any', 'all');--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "match_keywords" "bytea";--> statement-breakpoint
ALTER TABLE "category_rules" ADD COLUMN "keyword_mode" "keyword_mode" DEFAULT 'any' NOT NULL;