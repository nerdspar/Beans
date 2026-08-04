ALTER TABLE "accounts" ADD COLUMN "closed_on" date;
--> statement-breakpoint
/*
 * Backfill: an account already marked closed has a date now, or its history cannot be placed.
 *
 * `balance_as_of` is the last time anything observed this account, which is the most honest answer
 * available for when it stopped counting. Falling back to today for a row that never had one keeps
 * the column meaningful for every closed account rather than leaving a null the charts would have
 * to guess about.
 */
UPDATE "accounts"
   SET "closed_on" = COALESCE("balance_as_of"::date, CURRENT_DATE)
 WHERE "is_closed" = true AND "closed_on" IS NULL;
