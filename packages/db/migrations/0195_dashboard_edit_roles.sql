ALTER TABLE "dashboards" ADD COLUMN "edit_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
