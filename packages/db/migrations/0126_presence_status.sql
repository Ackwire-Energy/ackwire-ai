ALTER TABLE "organization_members" ADD COLUMN "availability" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "status_text" text;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "status_emoji" text;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "status_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_text" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_emoji" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_busy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_until" timestamp with time zone;