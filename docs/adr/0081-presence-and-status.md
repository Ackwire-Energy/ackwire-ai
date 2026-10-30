# 0081. Presence and written status, for people and agents

- Status: Proposed (built: the server, the shared client and §7–§11; the web and phone screens in the same change)
- Date: 2026-10-30
- Code: `packages/engine/src/member-status.ts`, `packages/engine/src/agent-status.ts` (`set_status`, `loadAgentStatuses`), `packages/engine/src/team.ts` (`find_agent`), `packages/engine/src/tools/run-policy.ts` (kind `self`), `packages/db/src/schema/tenancy.ts` (`organization_members.availability`, `status_*`), `packages/db/src/schema/agents.ts` (`agents.status_*`), `apps/server/src/routes/app/management.ts` (`/people`, `PUT …/me/status`), `apps/server/src/routes/app/agents.ts` (`GET …/agent-status`), `apps/server/src/realtime/ws.ts`, `packages/client/src/api/queries.ts` (`useSetMyStatus`, `useAgentStatuses`)

## Context

Presence was one boolean: a person with a WebSocket open was "online". People asked for the usual chat statuses (online, busy, hidden, offline) and a line saying what they are doing. In a workspace where agents work next to people, the same questions apply to an agent: is it on heavy work right now, answering someone, or idle?

## Decision

1. **People choose an availability**, per organization (`organization_members.availability`): `auto` (online while connected), `away` (out for a while: answers may take time), `busy` (online, but rather not interrupted) or `hidden`. What others see (`presence` on `GET …/people`) is `online`, `away`, `busy` or `offline`; a hidden person is `offline` to everyone else and `hidden` only to themselves, so the two can't be told apart. While hidden, `last_seen_at` stops moving and no connect/disconnect event goes out for them: either would give them away. `GET …/members` returns neither field.
2. **A written status** (`status_text`, at most 100 characters, an optional emoji and an optional end, `status_until`). An expired one reads as none: it's cleared on read, no job. `PUT …/me/status` sets either part; empty text clears the line.
3. **Agents' presence comes from their work**, never set by hand (`GET …/agent-status`): `busy` on a routine, a task (`issue_id`) or a run going for over 2 minutes, or when the agent said so; `online` while answering or waiting on an answer, and for 30 minutes after its last run; `away` after that; `offline` when held by the operators. An agent with no AI is drawn offline by the apps, which already read `ai-status`.
4. **Agents write their own line** with the built-in `set_status` (text, emoji, `busy`, optional `minutes`): "Revisando o PR #12". Without `minutes` it is tied to the run that wrote it (`agents.status_run_id`) and is gone when that run ends; with them it lasts up to a day. It is in every run's core tools (no scope), changes nothing but the agent's own line, and the run policy allows it for every kind of run (kind `self`), unaudited like `pass`.
5. **Agents see each other's status** in `find_agent` ("@ops: Ops (busy, on heavy work: Deploy da v2)"), which used to say only "working now". Nothing routes by it yet.
6. **Live.** Changes go out as org broadcasts with ids only: `member.status` (a person changed their status, or their first connection opened / last one closed) and `agent.status` (an agent's line). Clients refetch the people or the agents' presence; the agents' list also polls every 30 seconds, since presence follows time and runs elsewhere in the workspace.

## How an agent's status is set, and why it never sticks

7. **Three sources, one slot.** An agent's line comes from, in order: its own words (`set_status`, `agents.status_source = 'self'`), a line picked for the run (`'auto'`, §8), or nothing. An automatic line never replaces the agent's own in the same run. Both are tied to the run that wrote them (`status_run_id`).
8. **Jev picks the line, it never writes one.** Jev answers typed questions; it doesn't generate text. So code builds the candidate lines from facts everyone in the workspace may see, and Jev chooses one (a `choice` with a `none` option), in the request that already chooses the run's tool groups (ADR 0043, `chooseToolGroups`): same state, one call, no extra wait. Candidates, each with its emoji, written in the workspace's language from templates:
   - the task it works on (`issue_id`: "Trabalhando em: Login com Google"), the mission, the routine ("Rotina: Relatório semanal");
   - who it answers, only in a public channel ("Respondendo no #campanhas"); a DM or a private channel is only "Numa conversa privada" (a status is seen by the whole workspace: it never carries a private name or text);
   - what it does, from the tool groups it may use ("Pesquisando na web", "Programando", "Lendo o Drive", "Analisando dados", "Escrevendo na wiki").
   The trigger message goes into Jev's state only (untrusted, never shown). `none` or no Jev (a self-host without a TypeSafe key): the first fact that applies, in the order above, or no line.
9. **Busy from the start.** In the same request (`statusQuestions`, answered in `chooseToolGroups`, applied by `startRunStatus`), a `score` question rates how heavy the work is (a quick answer · a few short steps · minutes of work · long work in the background). Two top levels with probability ≥ 0.6 mark the run busy at once, instead of after 2 minutes. Without Jev, the 2-minute rule (§3) alone. The judge gets `score` as its third question type (`judge.ts`; the LLM fallback answers a level).
10. **It moves with the work.** When a run starts a step in another tool group, the automatic line is picked again from the candidates (code only, at most once every 30 s). An agent's own line is checked then: a `noul` ("does the line still describe the step it is on?"); under 0.3, the automatic line takes its place. Waiting on an approval, an answer or its computer, the line becomes "Esperando aprovação" / "Esperando resposta" / "Esperando o computador", and the agent reads `online`, not busy.
11. **Nothing can stick.** Every line is checked when read, never cleaned up by a job:
   - a run-bound line shows only while its run is active, and a `running` run counts only with a heartbeat from the last 90 s (a dead worker's run stops counting at once; recovery fails or requeues it within a minute, `recovery.ts`);
   - a run waiting for more than a day loses its line (it stays `online`);
   - an end time (`minutes`) is at most a day, and a person's `until` is checked on read;
   - every run start and end sends `agent.status`, so the apps refresh at once; their 30 s poll is only the backstop.

## Consequences

- Presence is still ephemeral (the `Presence` adapter); only the choice and the line are stored.
- Jev calls: none new; two questions ride on the tool-group request a run already makes. Line changes inside a run are code only; the staleness `noul` runs only when an agent wrote its own line and the run changes group.
- Open questions, left for later: whether `busy` should hold a person's pushes (Do not disturb), an automatic `away` for people idle while connected, a person's line from their calendar ("Em reunião até 15h"), and whether the router should prefer an agent that isn't busy.
