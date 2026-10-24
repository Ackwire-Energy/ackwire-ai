-- Another migration may add `kind` too (the workspace's own computers): whichever runs first adds it.
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "host_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "machines_host_org" ON "machines" USING btree ("org_id") WHERE "machines"."kind" = 'host';
