# 0016. Connectors in two layers over MCP

- Status: Accepted
- Date: 2026-10-14

## Decision

**Layer 1, the organization connects once.** `connector_connections` holds an org's connection to an MCP server: connector id (from our catalog), server URL (https), auth type and the credential (OAuth tokens or an API key, as JSON), envelope-encrypted like provider credentials and bound to `(org_id, id)`. One active connection per connector per org; reconnecting replaces it and moves the agents' grants over. Disconnecting deletes the grants. Secrets are never returned by any API.

**Layer 2, each agent gets a subset.** Grants live in `agent_scopes` with the connection id. A grant is accepted only if the connection is active in the org and the scope exists in that connector's catalog (`connectorGrantValidator`).

**Catalog** (`CONNECTOR_CATALOG`, code we own): for each connector (seeded: GitHub, Sentry, Linear, a Drive-like server) the scopes with labels, and a map from each MCP tool name to one of our scopes, with `sensitive` and an approval-title template. A tool the server lists but the catalog doesn't is never exposed. Merge, deploy and rollback stay sensitive regardless (0015).

**MCP client.** The connector `ToolSource` lists each connected server's tools with the official TypeScript SDK (`@modelcontextprotocol/sdk`, streamable HTTP, bearer token), caches the list for a minute, keeps catalog tools, and exposes them as `<connector>_<tool>` with the server's JSON Schema. Calls open a session through `McpConnect` (tests plug an in-process server via `InMemoryTransport`) and go through the Tool Gateway like every other tool. An unreachable server hides its tools for that turn.

**OAuth.** `startOAuth` (admins, `manage_connectors`) creates a single-use state (only its SHA-256 is stored), a PKCE verifier (sealed) with an S256 challenge, a 10-minute expiry and the person who started it, and returns the provider's authorize URL. The callback (`GET /api/app/connectors/oauth/callback`, session cookie) checks the state is unused, unexpired and the same person (still an admin), exchanges the code with the verifier and stores the tokens sealed, then redirects to the web app. Tokens expiring within a minute are refreshed before a call. Provider OAuth apps come from `CONNECTOR_*_CLIENT_ID/SECRET`; without them a connector can still be connected with an API key.

## Consequences

- Adding a connector is a catalog entry (and optionally OAuth endpoints); no migration.
- Tool output from MCP servers is untrusted content; it reaches the model only as a tool result.

## Addendum (2026-10-14): MCP-native OAuth and custom servers

**Custom MCP servers by URL.** An admin connects any https MCP server. The URL (and every URL learned from it: protected-resource metadata, authorization server endpoints, registration) passes the SSRF guard of ADR 0019. With an API key it is stored sealed; without one we probe the server: an open server connects at once; a `401` leads to OAuth discovery; otherwise the app asks for a key (`needs_key`). Each custom server is its own `connector_connections` row (`connector = custom:{id}`).

**MCP-native OAuth.** Discovery from `WWW-Authenticate: Bearer resource_metadata=…` or `/.well-known/oauth-protected-resource` (with and without the path), authorization server metadata by RFC 8414 (path insertion) then OpenID discovery, Dynamic Client Registration (RFC 7591, public client, `token_endpoint_auth_method: none`) stored per org and issuer in `oauth_clients` (a secret, if issued, is sealed), and the authorization code flow with state, PKCE S256 and the `resource` indicator (RFC 8707) on both the authorize and token requests. Refresh uses the registered client's token endpoint. Catalog connectors with a fixed OAuth app (GitHub, Sentry, Linear, Google Drive) keep using that app; a catalog entry without one would use the native flow. API keys stay as the last resort.

**Tools of custom servers are hidden until classified.** Every listed tool is stored in `custom_tools` with the server's `readOnlyHint`; an admin classifies each as `read`, `write` or `approval` and gives it a label in Portuguese. Only classified tools are offered, with scopes `custom:{connectionId}:read` (read) or `custom:{connectionId}:write` (write and approval); `approval` tools are sensitive, so every call is an approval request titled "{server}: {tool label}". Re-listing (`refresh`) adds new tools unclassified and marks removed ones.

## Addendum (2026-10-16): tools come classified; sensitive tools only ask or stay off

Listing a server's tools classifies each (`connectors/classify.ts`): the server's annotations first (`readOnlyHint` → read, `destructiveHint` → approval and sensitive), then the verb in the name (read verbs, write verbs, and sensitive verbs: delete, remove, send, pay, publish, transfer, refund, unbind, share, merge, deploy, rollback…), and for ambiguous names the shared Judge suggests a level and a reason code, in batches, cached per connection and tool name (`suggestion_source = judge`); judge failures suggest approval with reason `unknown` and are asked again on the next listing. A tool stays "pending" until a person confirms it (`confirmed_at`). Sensitive tools may only be `approval` or `off` (the API refuses read/write; the tool source marks them sensitive whatever is stored, and a re-list turns a stored free level back to approval). `write` tools run without approval and each call is audited (`connector.tool_changed`). The API returns readable name parts and a subject per tool; the web says them in the person's language.

## Addendum (2026-10-27): a custom server's own icon

A server connected by address shows the icon it lists in `serverInfo.icons` (MCP 2025-11-25, from `initialize`), read on every listing of its tools (`connectors/server-icon.ts`). We follow the spec's security rules for icons: only a `data:` URI or an https URL on the server's own origin, through the SSRF guard of ADR 0019, without credentials or redirects, with a 5 s timeout and at most 256 KB; only PNG, JPEG or WebP (no SVG: it can carry script, and the phone app can't draw it), typed by its bytes (a declared type must agree), at most 1024 px a side, and stripped of metadata. The icon is kept in the platform store (S3, `FILES_DIR` or Postgres) under the org's prefix (`orgs/{orgId}/connector-icons/…`, so in Postgres it goes with the org) and a content-hash name and served to the org's members by `GET /api/app/connector-icons/{orgId}/{connectionId}/{file}` (`connector_connections.icon`), so no browser loads anything from the server, and nothing about who uses it reaches the server or a third party. A catalog brand icon wins when there is one. A server that stops listing icons gets the monogram again; when all its icons fail, the last good one stays. We don't guess an icon from the server's website: that would mean fetching pages the server didn't point us to.

