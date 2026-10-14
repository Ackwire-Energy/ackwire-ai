# 0010. Real-time over native Bun WebSocket and a `PubSub` adapter

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D6, D18, D18a, D18b, D20.

## Decision

- **Endpoint** `GET /api/ws?orgId=<uuid>`, served by the same `Bun.serve` as the HTTP app (`apps/server/src/realtime/ws.ts`). The upgrade requires a Better Auth session cookie, an allowed `Origin` (prevents cross-site WebSocket hijacking), and membership of `orgId`.
- **Subscriptions:** the client sends `{"type":"subscribe","channelId":…}`. The server allows it only if `requireChannelAccess` passes for that org (same check as HTTP); otherwise it answers `{"type":"error","code":"forbidden"|"not_found"}`. At most 200 subscriptions per socket, 60 frames per 10 s, 16 KB frames.
- **Events** (`ChannelEvent` in `@agenteschat/engine`), forwarded as `{"type":"event","channelId","event"}`:
  - `message.created` — committed message (inline when small; otherwise only `messageId`, fetch it over HTTP);
  - `agent.run` — `running` (typing indicator), `done`, `failed` with a reason;
  - `agent.delta` — ordered (`seq`) fragments of an agent reply while it streams; not persisted, the final `message.created` replaces them.
- **Fan-out** goes through the `PubSub` adapter, topic `channel:<id>`. Core: Postgres LISTEN/NOTIFY on one channel (payload limit enforced below 8 KB; deltas are coalesced every 50 ms into ≤ 2000-character chunks). Cloud can register Redis. Postgres is the source of truth; real-time is best effort and clients catch up over HTTP on reconnect.
- **Presence** is tracked per connection through the `Presence` adapter (in-memory in core).

## Consequences

- One process serves HTTP, WebSocket and the SPA: no separate real-time service (supersedes the "realtime" row of the planejamento Infra table).
- Follow-ups: revoke live subscriptions when someone leaves a channel or organization (today the check runs at subscribe time; a reconnect re-checks), presence events to clients, typing indicators for people, `NOTIFY` throughput limits at Cloud scale (Redis adapter).
