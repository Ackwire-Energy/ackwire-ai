# 0056. Operator API and external provisioning

- Status: Accepted (2026-10-24)
- Date: 2026-10-24
- Extends: ADR 0002 (nothing private runs in the server process), ADR 0004 (configuration), ADR 0025 (connected computers)

## Context

Whoever runs an instance for other people (agentes.chat Cloud is one) needs things the app's own API doesn't give: look up any workspace or account to answer a support or abuse case, hold or suspend a workspace, and give each workspace a computer prepared by an external provisioner the operator runs. ADR 0002 rules out a private module inside the server process, so those services run apart and talk to the server over the network.

The app API (`/api/app/*`) is the wrong door for them: it acts as one person (cookie session, CSRF), it changes freely between versions, and it sits on the public address.

## Decision

### 1. Its own listener, off by default

- `OPERATOR_API_TOKEN` (at least 32 characters) turns it on. Unset, nothing listens. Set, a second `Bun.serve` on `OPERATOR_API_PORT` (default 3001, same `HOST`) serves `/api/operator/v1/*` and nothing else (`apps/server/src/operator/app.ts`, started in `start.ts`).
- The public listener (`PORT`) never mounts it: `/api/operator/*` there is a 404, token or not.
- The port belongs to the operator's private network. The compose file doesn't publish it; a service on the same Docker network calls `http://agentes:3001`. It is never published nor put behind the public reverse proxy.

### 2. One bearer token

- Every request carries `Authorization: Bearer <OPERATOR_API_TOKEN>`, compared in constant time. Anything else is a 401, on every path under the prefix (unknown ones and the OpenAPI document too), so nothing about the API answers without it.
- No cookies and no CORS headers, so a web page can't call it on a visitor's behalf.
- The token reaches every workspace and account on the instance. It lives only in the server's environment and the caller's, is never logged (`secret: true` in the schema), and is rotated by hand.

### 3. A versioned contract

- The caller deploys apart from the server, so a server deploy must never break it silently. The version is in the path, `/api/operator/v1`.
- The OpenAPI document is served at `/api/operator/v1/openapi.json`, and a copy is committed in `apps/server/test/operator-openapi.json`. A test compares the two, so every change to the contract is a reviewed diff.
- Adding an endpoint or a field keeps `v1`. Renaming, removing or changing the meaning of one makes `v2`, served next to `v1` until the callers have moved.

### 4. Reads: who and what, never what anyone wrote

| Method, path | Answer |
| --- | --- |
| `GET /health` | `{ ok, version }` |
| `GET /orgs?q&createdAfter&limit&cursor` | `{ orgs: [{ id, name, createdAt, members, agents }], next }`, newest first, in keyset pages of up to 200. `q` is an org id, part of the name or part of a member's email, in any case, matched literally |
| `GET /orgs/{orgId}` | `id, name, createdAt`; owners and admins (`userId, email, name, role, createdAt, lastSeenAt`); counts of members, agents, channels, connected computers and pending invitations |
| `GET /users/{userId}` | `id, email, name, emailVerified, createdAt`; the workspaces with role; the 10 newest sessions on record (`ip, userAgent, createdAt`) |

The reads live in `packages/engine/src/operator.ts` and pick every field by name. Answers name people and workspaces and say how much is in them, nothing more: never messages, files, prompts or the workspace's context, and never a credential, token or password hash.

### 5. Hooks are pulled, never pushed

The server never calls the operator's services. What it has for them waits in Postgres until they ask, and what they decide comes back through this API:

- an events feed (`GET /events?after=`): sign-ups, sessions, workspaces created and deleted, invitations, agents and mail sent, as metadata only, recorded only while the operator API is on;
- standing: a workspace `active`, on `hold` or `suspended`, an agent held, an account blocked; set here and enforced by the server at its existing choke points (model gateway, computer calls, permission checks, invitations, sign-in);
- external provisioning (`MACHINE_PROVISIONING=external`): each workspace without a ready computer is a request the provisioner lists. It reports progress, and asks for a single-use enrollment code that the computer redeems through the device-code flow of ADR 0025, so the computer's own token never passes through the provisioner.

Nothing is lost while those services are down, and the server needs no delivery, retry or signing code. These endpoints join this API under the same token and the same contract test.

## Consequences

- A self-hosted instance gets no new surface unless its admin sets the token; with it, the same API serves their own automation.
- One token holds every operator power. Splitting it (read-only, per caller) waits for a second caller.
- Answers carry personal data (names, emails, IP addresses). Callers keep what they copy under their own retention rules.
- A change to the contract fails the test until the committed document is regenerated (`UPDATE_OPERATOR_OPENAPI=1` on `apps/server/test/operator.test.ts`), so it is always a deliberate diff.
