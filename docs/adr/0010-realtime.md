# 0010. Real-time over native Bun WebSocket and a `PubSub` adapter

- Status: Accepted
- Date: 2026-10-14

## Decision

- **Endpoint** `GET /api/ws?orgId=<uuid>`, served by the same `Bun.serve` as the HTTP app (`apps/server/src/realtime/ws.ts`). The upgrade requires a Better Auth session cookie, an allowed `Origin` (prevents cross-site WebSocket hijacking), and membership of `orgId`.
- **Subscriptions:** the client sends `{"type":"subscribe","channelId":…}`. The server allows it only if `requireChannelAccess` passes for that org (same check as HTTP); otherwise it answers `{"type":"error","code":"forbidden"|"not_found"}`. At most 200 subscriptions per socket, 60 frames per 10 s, 16 KB frames.
- **Events** (`ChannelEvent` in `@agenteschat/engine`), forwarded as `{"type":"event","channelId","event"}`:
  - `message.created` — committed message (inline when small; otherwise only `messageId`, fetch it over HTTP);
  - `agent.run` — `running` (typing indicator), `done`, `failed` with a reason;
  - `agent.delta` — ordered (`seq`) fragments of an agent reply while it streams; not persisted, the final `message.created` replaces them;
  - `message.reactions` — someone reacted (emoji, or `+1`/`-1`) or took it back: the message's full reaction list, which replaces the client's.
  - `machine.task` — a background task on a connected computer started, reported progress (last line, files, seconds), ended, was interrupted or resumed: `{ channelId, threadId, task }` with the task's whole view (replace, don't merge); `threadId` null = the main timeline (ADR 0029).
  - `mission.updated` — a mission changed (ADR 0029): `{ channelId, threadId, missionId, status, change }` where `change` is `proposed | started | paused | resumed | stopped | closed | plan | participants | owner | machine | decision | review | suggestion | task | file_edited`, with small details when at hand (`decision`, `review`, `messageId` + `suggestion`, `taskId`, `planVersion`, `canceled`, `outcome`, `code`). Sent to the mission's home channel; clients refetch `GET …/missions/{missionId}` for the rest. Its tasks keep sending `machine.task`. The owner also gets user events `mission.needs_you` (a decision or review), `mission.approval_requested` and `mission.approval_decided`.
  - `thread.updated` — a thread was created from a range, renamed, its range changed, moved out of the channel or back, closed, reopened, archived, unarchived or undone (`change`), with its `state` and, when the server has it, the fresh `thread` view; `messageIds` lists the messages that left or came back to the channel (up to 50; otherwise refetch). Sent to the thread's channel and to the range's channel when different (ADR 0029).
- **Fan-out** goes through the `PubSub` adapter, topic `channel:<id>`. Core: Postgres LISTEN/NOTIFY on one channel (payload limit enforced below 8 KB; deltas are coalesced every 50 ms into ≤ 2000-character chunks). Cloud can register Redis. Postgres is the source of truth; real-time is best effort and clients catch up over HTTP on reconnect, and each time the server confirms a channel's subscription (`subscribed`), the first one included: a channel's events reach a socket only from then on, so what was published between a page's read and that moment (an answer that needs no model, posted while the socket opened after a page change) would be missing until a reload. That read adds what the lists lack and takes nothing away: replacing a list would drop a message heard live while the read was on its way (`catchUpChannel` in `@agenteschat/client`, the web app and the phone app since 2026-10-26). A read can be older than events heard while it was on its way, so on the web a receipt the server confirmed takes from it only how the run it follows ended, never an older run's end over a newer one ("Responder agora" starts a new run), unless nothing changed that receipt since the read was asked for.
- **Presence** is tracked per connection through the `Presence` adapter (in-memory in core).

## Consequences

- One process serves HTTP, WebSocket and the SPA: no separate real-time service.
- Follow-ups: revoke live subscriptions when someone leaves a channel or organization (today the check runs at subscribe time; a reconnect re-checks), presence events to clients, typing indicators for people, `NOTIFY` throughput limits at Cloud scale (Redis adapter).
