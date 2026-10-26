ALTER TABLE "audit_log" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "on_behalf_of_user_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "outcome" text;--> statement-breakpoint
CREATE INDEX "audit_log_org_id_actor_type_actor_id_created_at_index" ON "audit_log" USING btree ("org_id","actor_type","actor_id","created_at");