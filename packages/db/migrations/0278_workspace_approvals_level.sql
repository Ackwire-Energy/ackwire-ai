ALTER TABLE "agents" ADD COLUMN "approvals_level_own" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "approvals_level" text DEFAULT 'risky' NOT NULL;--> statement-breakpoint
-- An agent someone moved off the default keeps that choice; the rest follow the workspace, which starts at 'risky'.
UPDATE "agents" SET "approvals_level_own" = true WHERE "approvals_level" <> 'risky';
