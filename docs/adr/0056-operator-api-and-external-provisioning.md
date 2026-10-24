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

The reads live in `packages/engine/src/operator.ts` and pick every field by name. Answers name people and workspaces and say how much is in them, nothing more: never messages, files, prompts or the workspace's context, and never a credential, token or password hash. The review blocks of §6 are the one door to content, and every read of one is recorded.

### 5. The events feed: what happened, as metadata

`GET /events?after&limit` (up to 1000) answers `{ events: [{ id, at, type, orgId, userId, data }], next }`, oldest first. `userId` is the person the event is about or who acted. The server writes each event in the transaction of what it records (or right after a sign-in commits), in `operator_events` (`packages/engine/src/operator-events.ts`):

| Type | Written when | `data` |
| --- | --- | --- |
| `user.signed_up` | an account's first sign-in method is created | `email`, `method` (`email`, `google`, `github`, `apple`) |
| `session.created` | someone signs in | `ip`, `userAgent` (512 characters at most) |
| `user.deleted` | an account is deleted | none |
| `organization.created` | a workspace is created | `name` |
| `organization.deleted` | a workspace goes with its last member's account | none |
| `invitation.created` | an invitation is sent or resent, or an invite link is made | `emailDomain`, `role`, `resent: true` when resent; `link: true` for a link |
| `agent.created` | an agent is created | `agentId` |
| `mail.sent` | an agent sends, replies to or forwards an email | `agentId`, `runId`, `kind`, `recipients` (how many), `domains` |
| `run.finished` | an agent's run ends (done, failed or canceled) | `runId`, `agentId`, `brain`, `status`, `toolCalls` |
| `task.finished` | a task on a computer ends (done, failed, canceled, or interrupted for good) | `taskId`, `agentId`, `executor`, `status` |
| `content.viewed` | a review block is read (§6) | `ref` (`run:<id>` or `task:<id>`), `reason`, `operator` |

- **Metadata only.** Ids, counts, domains and where a sign-in came from: never a message, prompt, subject, address list, file, credential or token. Content leaves only through §6.
- **Off by default.** Events are recorded only while the operator API is on (`OPERATOR_API_TOKEN` set); without it the table stays empty. `content.viewed` is always recorded, since a review block can't be read without the API.
- **No foreign keys.** An event outlives the workspace or account it names: that is when an abuse case needs it.
- **Paging never skips an event.** Ids and timestamps are taken before a transaction commits, so a slow transaction can commit an event that sorts before one already served. Each row keeps the id of the transaction that wrote it (`xid8`, from `pg_current_xact_id()`); the feed is ordered by it and serves only rows whose transaction is below `pg_snapshot_xmin(pg_current_snapshot())`, the point below which every transaction has ended. A row committed later always sorts after the cursor. The cost: a long transaction anywhere on the database holds the feed back until it ends; nothing is lost meanwhile.
- **`next`** is opaque. Pass it as `after`; an empty page returns the same value, so the caller polls with it until something new comes. Callers skip types they don't know: new types and fields keep `v1`.
- **Kept 90 days** (pruned daily by the workers). The operator's services copy what they need and keep it under their own retention rules.

### 6. Review blocks: the only content

`GET /review/{run|task}/{id}?reason&operator` answers `{ kind, id, orgId, agentId, text }`: what one run or task did, for an abuse review (`packages/engine/src/operator-review.ts`).

- **Built by the server, never raw rows.** A run's block holds the message that started it, each tool call with its input and result, and the reply; a task's holds its title, the message behind it, its prompt, command, result, last lines of output and the files it touched. Plus a header of ids, brain or executor, status and times.
- **At most 12,000 bytes.** Every piece is cut first; when they still don't fit, the lowest-ranked go (tool calls before the request and the reply), and a last line says how many were left out.
- **Credentials masked** by their shapes (API keys, tokens, `Bearer` headers, `password=` and `token:` values, private keys) before anything is cut. Tool inputs are written as `key: value` lines so a field named like a secret is masked too.
- **Workspace text is quoted.** Everything people, agents, tools or web pages wrote is inside `<external_data>` envelopes, with any copy of the markers neutralised, so the reader (a person, or a model that judges it) weighs it as data and never follows it.
- **Every read leaves a trail.** `reason` and `operator` are required; a `content.viewed` event is written before the block is returned, in this server's database, where the operator's own services can't erase it.

### 7. Hooks are pulled, never pushed

The server never calls the operator's services. What it has for them waits in Postgres until they ask (the events feed above), and what they decide comes back through this API:

- standing: a workspace `active`, on `hold` or `suspended`, an agent held, an account blocked; set here and enforced by the server at its existing choke points (model gateway, computer calls, permission checks, invitations, sign-in);
- external provisioning (`MACHINE_PROVISIONING=external`): each workspace without a ready computer is a request the provisioner lists. It reports progress, and asks for a single-use enrollment code that the computer redeems through the device-code flow of ADR 0025, so the computer's own token never passes through the provisioner.

Nothing is lost while those services are down, and the server needs no delivery, retry or signing code. These endpoints join this API under the same token and the same contract test.

## Consequences

- A self-hosted instance gets no new surface unless its admin sets the token; with it, the same API serves their own automation.
- One token holds every operator power. Splitting it (read-only, per caller) waits for a second caller.
- Answers carry personal data (names, emails, IP addresses), and with the token set the server keeps 90 days of events about people who may have deleted their account since. Callers keep what they copy under their own retention rules.
- The feed can lag behind by as long as the longest transaction running on the database.
- A change to the contract fails the test until the committed document is regenerated (`UPDATE_OPERATOR_OPENAPI=1` on `apps/server/test/operator.test.ts`), so it is always a deliberate diff.
