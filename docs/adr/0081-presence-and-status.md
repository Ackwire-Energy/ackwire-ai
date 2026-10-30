# 0081. Presence and written status, for people and agents

- Status: Proposed (built: the server and the shared client; the web and phone screens wait for their design)
- Date: 2026-10-30
- Code: `packages/engine/src/member-status.ts`, `packages/engine/src/agent-status.ts` (`set_status`, `loadAgentStatuses`), `packages/engine/src/team.ts` (`find_agent`), `packages/engine/src/tools/run-policy.ts` (kind `self`), `packages/db/src/schema/tenancy.ts` (`organization_members.availability`, `status_*`), `packages/db/src/schema/agents.ts` (`agents.status_*`), `apps/server/src/routes/app/management.ts` (`/people`, `PUT …/me/status`), `apps/server/src/routes/app/agents.ts` (`GET …/agent-status`), `apps/server/src/realtime/ws.ts`, `packages/client/src/api/queries.ts` (`useSetMyStatus`, `useAgentStatuses`)

## Context

Presence was one boolean: a person with a WebSocket open was "online". People asked for the usual chat statuses (online, busy, hidden, offline) and a line saying what they are doing. In a workspace where agents work next to people, the same questions apply to an agent: is it on heavy work right now, answering someone, or idle?

## Decision

1. **People choose an availability**, per organization (`organization_members.availability`): `auto` (online while connected), `busy` (online, but rather not interrupted) or `hidden`. What others see (`presence` on `GET …/people`) is `online`, `busy` or `offline`; a hidden person is `offline` to everyone else and `hidden` only to themselves, so the two can't be told apart. While hidden, `last_seen_at` stops moving and no connect/disconnect event goes out for them: either would give them away. `GET …/members` returns neither field.
2. **A written status** (`status_text`, at most 100 characters, an optional emoji and an optional end, `status_until`). An expired one reads as none: it's cleared on read, no job. `PUT …/me/status` sets either part; empty text clears the line.
3. **Agents' presence comes from their work**, never set by hand (`GET …/agent-status`): `busy` on a routine, a task (`issue_id`) or a run going for over 2 minutes, or when the agent said so; `online` while answering or waiting on an answer, and for 30 minutes after its last run; `away` after that; `offline` when held by the operators. An agent with no AI is drawn offline by the apps, which already read `ai-status`.
4. **Agents write their own line** with the built-in `set_status` (text, emoji, `busy`, optional `minutes`): "Revisando o PR #12". Without `minutes` it is tied to the run that wrote it (`agents.status_run_id`) and is gone when that run ends; with them it lasts up to a day. It is in every run's core tools (no scope), changes nothing but the agent's own line, and the run policy allows it for every kind of run (kind `self`), unaudited like `pass`.
5. **Agents see each other's status** in `find_agent` ("@ops: Ops (busy, on heavy work: Deploy da v2)"), which used to say only "working now". Nothing routes by it yet.
6. **Live.** Changes go out as org broadcasts with ids only: `member.status` (a person changed their status, or their first connection opened / last one closed) and `agent.status` (an agent's line). Clients refetch the people or the agents' presence; the agents' list also polls every 30 seconds, since presence follows time and runs elsewhere in the workspace.

## Consequences

- Presence is still ephemeral (the `Presence` adapter); only the choice and the line are stored.
- Open questions, left for later: whether `busy` should hold a person's pushes (Do not disturb), an automatic `away` for people idle while connected, and whether the router should prefer an agent that isn't busy.
