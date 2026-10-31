ALTER TABLE "agents" ADD COLUMN "media_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "gifs" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "gif_rating" text DEFAULT 'g' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "agent_stickers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "agent_media" text DEFAULT 'sometimes' NOT NULL;