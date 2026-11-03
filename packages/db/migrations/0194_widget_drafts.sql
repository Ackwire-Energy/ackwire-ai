ALTER TABLE "dashboard_widgets" ADD COLUMN "title_set_by_user" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "draft" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "dashboard_widgets_drafts" ON "dashboard_widgets" USING btree ("org_id","created_by_user_id") WHERE "dashboard_widgets"."draft" = true;
