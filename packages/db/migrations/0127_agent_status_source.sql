ALTER TABLE "agents" ADD COLUMN "status_source" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_kind" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_subject" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status_at" timestamp with time zone;