-- Widgets an agent made kept no person (`created_by_user_id` null). One case names them for certain: the run that
-- made it was started by a person's own message (not a routine's brief), so it is that person's, while they are
-- still in the workspace. The rest stay null and think with their routine's creator's AI, else the workspace's.
UPDATE "dashboard_widgets" w
SET "created_by_user_id" = m."author_user_id"
FROM "agent_runs" r
JOIN "messages" m ON m."org_id" = r."org_id" AND m."id" = r."trigger_message_id"
JOIN "organization_members" om ON om."org_id" = r."org_id" AND om."user_id" = m."author_user_id"
WHERE w."created_by_user_id" IS NULL
  AND r."id" = w."created_by_run_id"
  AND r."org_id" = w."org_id"
  AND r."background" = false
  AND m."author_type" = 'person'
  AND NOT (m."meta" ? 'routineBrief')
  AND coalesce(m."meta" ->> 'background', '') <> 'true';
