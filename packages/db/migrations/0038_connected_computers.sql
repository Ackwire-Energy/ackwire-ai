ALTER TYPE "public"."artifact_kind" ADD VALUE 'file';--> statement-breakpoint
CREATE TABLE "artifact_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"computer" text NOT NULL,
	"machine_id" uuid,
	"path" text NOT NULL,
	"title" text,
	"note" text,
	"target_artifact_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"max_bytes" integer NOT NULL,
	"artifact_id" uuid,
	"version" integer,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "artifact_uploads" ADD CONSTRAINT "artifact_uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_uploads" ADD CONSTRAINT "artifact_uploads_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_uploads_org_id_created_at_index" ON "artifact_uploads" USING btree ("org_id","created_at");