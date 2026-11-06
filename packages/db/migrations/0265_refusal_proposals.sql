-- A refused change was saved as a lesson, and a strong lesson became a new proposal: refusing made more to refuse.
-- Those proposals go, unless a person accepted one (the row explains the line now in the instructions). Their lines in
-- `instructions` and `context` stay: changing that text would turn every open proposal on it stale.
DELETE FROM "context_proposals"
WHERE "status" <> 'accepted'
  AND "diff" LIKE '%+- A person refused this change; don''t propose it again:%';
--> statement-breakpoint
-- Refusing one of those taught a lesson about a lesson: nothing an agent can use.
UPDATE "context_items"
SET "status" = 'archived', "updated_at" = now()
WHERE "status" = 'active'
  AND "content" LIKE 'A person refused this change; don''t propose it again: %A person refused this change; don''t propose it again:%';
--> statement-breakpoint
-- The same change open several times: the newest stays, the others read as out of date. A row whose lines differ is
-- another change and stays open.
WITH keyed AS (
  SELECT p."id", row_number() OVER (
    PARTITION BY p."org_id", p."target", p."agent_id", p."skill_path", (
      SELECT string_agg(d.line, E'\n' ORDER BY d.at)
      FROM unnest(string_to_array(p."diff", E'\n')) WITH ORDINALITY AS d(line, at)
      WHERE d.line ~ '^[+-]' AND btrim(substr(d.line, 2)) NOT IN ('', '## Learned')
    )
    ORDER BY p."created_at" DESC, p."id" DESC
  ) AS "place"
  FROM "context_proposals" p
  WHERE p."status" = 'pending' AND p."target" IN ('agent_instructions', 'org_context', 'agent_role', 'skill')
)
UPDATE "context_proposals" p
SET "status" = 'stale', "decided_at" = now()
FROM keyed k
WHERE k."id" = p."id" AND k."place" > 1;
