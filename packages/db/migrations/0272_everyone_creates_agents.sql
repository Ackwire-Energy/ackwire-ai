-- ADR 0085: every member creates agents by default, so `everyone` gains `create_agents`. A workspace where a custom
-- role already holds it keeps its roles as they are: an admin chose there who creates agents.
UPDATE "org_roles" r SET "permissions" = array_append(r."permissions", 'create_agents')
WHERE r."kind" = 'everyone'
  AND NOT ('create_agents' = ANY(r."permissions"))
  AND NOT EXISTS (
    SELECT 1 FROM "org_roles" c
    WHERE c."org_id" = r."org_id" AND c."kind" <> 'everyone' AND 'create_agents' = ANY(c."permissions")
  );
