-- One waiting notice per connected server whose approved tools changed (ADR 0117). Before a server kept one, every
-- change added a row, so the inbox showed the same "changed tools" card several times. Each person's older open rows
-- of a server are resolved where a newer one is open (its review lists every pending change), and the open ones name
-- their server, which the notice's group key carries (`connector_tool_changed:<connection>:<fingerprint>`).
UPDATE "notifications" AS n SET "done_at" = now()
WHERE n."kind" = 'connector_tool_changed' AND n."done_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "notifications" AS m
    WHERE m."org_id" = n."org_id" AND m."user_id" = n."user_id" AND m."kind" = 'connector_tool_changed'
      AND m."done_at" IS NULL AND split_part(m."group_key", ':', 2) = split_part(n."group_key", ':', 2)
      AND (m."updated_at", m."id") > (n."updated_at", n."id")
  );--> statement-breakpoint
UPDATE "notifications" SET "source" = "source" || jsonb_build_object('connectionId', split_part("group_key", ':', 2))
WHERE "kind" = 'connector_tool_changed' AND "done_at" IS NULL AND split_part("group_key", ':', 2) <> ''
  AND NOT ("source" ? 'connectionId');
