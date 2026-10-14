# 0006. Better Auth for people; our own organizations, roles and agents

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D19. Same split as Tierbird ADR 0011.

## Decision

- **Better Auth** handles people: users, sessions (HttpOnly cookie, same origin as the web app), email + password, optional Google/GitHub, rate limiting. Mounted at `/api/auth/*`, tables `users`, `sessions`, `accounts`, `verifications` via the Drizzle adapter. Its secret derives from `AGENTES_SECRET`.
- **agentes.chat owns tenancy:** `organizations` (with `context`, injected into every agent prompt), `organization_members` (owner / admin / member) and `organization_invitations` (7-day links, only the SHA-256 of the token stored, accepted only by the invited email). The Better Auth organization plugin is not used.
- **Permissions** (`@agenteschat/engine` `can`, `requirePermission`), checked on every request:
  - member: `read`, `post`, `create_channels`
  - admin: + `configure`, `manage_agents`, `manage_credentials`, `view_usage`, `manage_members`
  - owner: + `manage_owners`. An organization always keeps an owner.
- **Channel access** is one function, `requireChannelAccess` (org member + channel in that org + channel member), used by the HTTP API and the WebSocket.
- **Agents are not users.** They live in `agents`; messages have a polymorphic author (`person` | `agent`). Agent permissions will come from their scopes (Tool Gateway), never from roles or prompts.
- **Sign-up policy (self-host):** the first account may always sign up and becomes owner of any existing organizations; afterwards sign-up needs `ALLOW_SIGNUP=true` or a pending invitation. Cloud runs with `ALLOW_SIGNUP=true`.
- **App API** `/api/app/*` is private to our web app: cookie session, CSRF protection (writes need our `Origin` and a JSON body), described in the OpenAPI document so the web app can generate a typed client.

## Consequences

- No external identity provider; self-host stays one container + Postgres.
- Composite foreign keys `(org_id, id)` keep channel memberships, messages, runs and usage from pointing across organizations.
- Later: Better Auth `jwt` + `oauthProvider` for MCP clients (D19).
