ALTER TABLE "machine_accounts" ADD COLUMN "serves" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
-- Every plan now serves the whole workspace: each person who connected one hears it once per account, with the way
-- back ("Só eu"), where the workspace has someone else it now serves.
INSERT INTO "notifications" ("id", "org_id", "user_id", "kind", "group_key", "source", "latest")
SELECT gen_random_uuid(), a."org_id", a."created_by", 'plan_serves', 'plan_serves:' || a."id",
  jsonb_build_object('accountId', a."id", 'machineId', a."machine_id"),
  jsonb_build_object('plan', a."label")
FROM (
  SELECT DISTINCT ON ("org_id", "machine_id", "created_by", "kind", coalesce("provider", ''), coalesce(lower("email"), "id"::text)) *
  FROM "machine_accounts"
  WHERE "status" IN ('active', 'signed_out') AND "created_by" IS NOT NULL
  ORDER BY "org_id", "machine_id", "created_by", "kind", coalesce("provider", ''), coalesce(lower("email"), "id"::text), "created_at"
) a
WHERE EXISTS (SELECT 1 FROM "organization_members" m WHERE m."org_id" = a."org_id" AND m."user_id" = a."created_by")
  AND (SELECT count(*) FROM "organization_members" m WHERE m."org_id" = a."org_id") > 1
ON CONFLICT DO NOTHING;
