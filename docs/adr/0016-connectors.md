# 0016. Connectors in two layers over MCP

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D7 (our scopes for MCP tools) and the "Conectores em 2 camadas" concept.

## Decision

**Layer 1, the organization connects once.** `connector_connections` holds an org's connection to an MCP server: connector id (from our catalog), server URL (https), auth type and the credential (OAuth tokens or an API key, as JSON), envelope-encrypted like provider credentials and bound to `(org_id, id)`. One active connection per connector per org; reconnecting replaces it and moves the agents' grants over. Disconnecting deletes the grants. Secrets are never returned by any API.

**Layer 2, each agent gets a subset.** Grants live in `agent_scopes` with the connection id. A grant is accepted only if the connection is active in the org and the scope exists in that connector's catalog (`connectorGrantValidator`).

**Catalog** (`CONNECTOR_CATALOG`, code we own): for each connector (seeded: GitHub, Sentry, Linear, a Drive-like server) the scopes with labels, and a map from each MCP tool name to one of our scopes, with `sensitive` and an approval-title template. A tool the server lists but the catalog doesn't is never exposed. Merge, deploy and rollback stay sensitive regardless (0015).

**MCP client.** The connector `ToolSource` lists each connected server's tools with the official TypeScript SDK (`@modelcontextprotocol/sdk`, streamable HTTP, bearer token), caches the list for a minute, keeps catalog tools, and exposes them as `<connector>_<tool>` with the server's JSON Schema. Calls open a session through `McpConnect` (tests plug an in-process server via `InMemoryTransport`) and go through the Tool Gateway like every other tool. An unreachable server hides its tools for that turn.

**OAuth.** `startOAuth` (admins, `manage_connectors`) creates a single-use state (only its SHA-256 is stored), a PKCE verifier (sealed) with an S256 challenge, a 10-minute expiry and the person who started it, and returns the provider's authorize URL. The callback (`GET /api/app/connectors/oauth/callback`, session cookie) checks the state is unused, unexpired and the same person (still an admin), exchanges the code with the verifier and stores the tokens sealed, then redirects to the web app. Tokens expiring within a minute are refreshed before a call. Provider OAuth apps come from `CONNECTOR_*_CLIENT_ID/SECRET`; without them a connector can still be connected with an API key.

## Consequences

- Adding a connector is a catalog entry (and optionally OAuth endpoints); no migration.
- Tool output from MCP servers is untrusted content; it reaches the model only as a tool result.
