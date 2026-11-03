-- "Concluídas" before done_by_user existed: mentions, reactions and thread replies are only ever closed by the
-- person ("Concluir"), never auto-resolved, so a done row of these kinds from the last 30 days was theirs.
UPDATE "notifications" SET "done_by_user" = true
WHERE "kind" IN ('mention', 'reaction', 'thread_reply')
  AND "done_at" IS NOT NULL
  AND NOT "done_by_user"
  AND "done_at" > now() - interval '30 days';
