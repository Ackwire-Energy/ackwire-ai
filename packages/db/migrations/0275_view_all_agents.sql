-- ADR 0085: `view_all_agents` lists every agent on Equipe, its sectors and the counts. `everyone` gains it in every
-- workspace, so nothing changes until an admin turns it off.
UPDATE "org_roles" SET "permissions" = array_append("permissions", 'view_all_agents')
WHERE "kind" = 'everyone' AND NOT ('view_all_agents' = ANY("permissions"));
