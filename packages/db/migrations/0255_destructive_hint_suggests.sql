-- A server's destructiveHint only suggests asking: tools locked for that hint alone can have their level changed.
-- Their level stays as it is. Still locked, as the classifier locks them: a name with one of its sensitive verbs in
-- any position, Composio's meta tools, and the actions of a Composio toolkit, whose hint is the classifier's own rule.
UPDATE "custom_tools" AS t
SET "sensitive" = false
WHERE t."sensitive"
  AND t."suggestion_reason" = 'destructive_hint'
  AND NOT (
    regexp_split_to_array(lower(regexp_replace(t."name", '([a-z0-9])([A-Z])', '\1_\2', 'g')), '[^a-z0-9]+')
    && ARRAY['delete', 'remove', 'send', 'pay', 'publish', 'transfer', 'refund', 'unbind', 'share', 'merge', 'deploy', 'rollback', 'destroy', 'drop', 'purge']
  )
  AND t."name" NOT IN ('COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL', 'COMPOSIO_PROXY_EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM "connector_connections" AS c
    WHERE c."id" = t."connection_id" AND c."server_url" ~* '^https://backend\.composio\.dev/api/v3\.1/toolkits/'
  );
