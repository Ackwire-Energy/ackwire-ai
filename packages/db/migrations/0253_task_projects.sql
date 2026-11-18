CREATE TABLE "issue_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'graphite' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_projects" ADD CONSTRAINT "issue_projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_projects_org_name" ON "issue_projects" USING btree ("org_id",lower("name"));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_issue_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."issue_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_org_id_project_id_index" ON "issues" USING btree ("org_id","project_id");