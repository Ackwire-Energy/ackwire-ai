ALTER TABLE "machines" ADD COLUMN "spill_own" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "spill_others" boolean DEFAULT false NOT NULL;