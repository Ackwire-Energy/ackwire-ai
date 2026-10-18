# 0034. Agents talk to each other: private consultations and chiming in

- Status: Accepted (built; UI pending a prototype)
- Date: 2026-10-17
- Planning: D49 (revises D5)
- Extends: ADR 0013 (router), ADR 0015 (approvals), ADR 0032 (agent engine)

## Context

Agents only talked to people. Another agent woke up only through an explicit @mention that a judge read as "act now", once in a row, and the router ignored agents' messages (D5). Three problems showed up in #general on 2026-10-17:

1. "theo conta pro pessoal…" got no answer. Jev scored Theo 1.0 ("best @theo, confidence 0.99") but its separate "should any agent reply?" Noul said 0.22, and `selectAgents` treated that as a veto.
2. A dev agent that needs something from the infra agent mid-task has no way to ask and wait. It can only post an @mention and end its run.
3. "@Theo" sent alone after the request was read as an empty message: the prompt said to answer only the current message.

The reference is Grokbot: agents ask each other privately ("message from Tec") and a message to the room wakes several of them.

## Decision

**1. `ask_agent`: a private consultation that the asking run waits on.**
- A built-in tool (no scope) with `agent` (handle) and `question`. Code allows only an active agent of the org other than the asker, one the person behind the run can talk to (D31), and one not already in the chain.
- The question is posted in the **private DM between the two agents**: a `dm` channel with key `a:<id>|a:<id>` and the two agents as its only members. No person reads it or sees it in their DMs. The consulted agent runs there (`trigger = dm`) with its own scopes; nothing is granted. Sensitive actions still need a person's approval.
- The asking run pauses on the call's `waitId` (the generic wait of `run-resume.ts`, as for missions). When the consulted run ends, `onConsultedRunFinished` takes its reply and resumes the asker with `@infra answered: …`. A failed run resumes it with the failure. After `CONSULTATION_TTL_MS` (15 min) a worker resumes it without an answer.
- `agent_consultations` (migration 0064) holds the asking run, both agents, the DM, the question message, the consulted run, the wait, `chain` (the agents already in the chain), status and answer.
- Limits: no cycles (the consulted agent can't ask back anyone in `chain`) and at most `MAX_CONSULTATION_CHAIN` = 2 agents deep (Dev → Infra → one more). Inside an agents' DM, `ask_user` is refused (no person reads it) and agent messages start nobody by mention.
- The asker's next reply carries `meta.consulted` (`agentId`, `consultationId`, `status`) for the "message from @infra" card, and `agent.consulted` is published on the asker's channel.

**2. The router may pick a clear choice even when "needs any agent" is low.** `RouterPolicy.clearPickScore` (default 0.8): an agent scored this high answers even when the need-any-agent score is under the gate.

**3. A message to the room may wake up to four agents** (`maxAgents` 2 → 4). Each agent is still scored on its own and must clear the threshold.

**4. Agents' messages go through the router too (D5 revised).** An agent's message without mentions, in a channel and outside a mission's thread, is routed with a stricter policy:
- the author is never a candidate, and neither is any agent that already spoke in the recent history;
- at most one agent is picked, and only a clear pick (`AGENT_CHIME_IN_SCORE` = 0.75);
- never from an answer to an answer (`hop >= 2`);
- no continuity.

Receipts are published only when someone is picked.

**5. Prompt.** When the current message only calls the agent (its handle or name, or a nudge such as "e aí?"), the agent answers the same person's previous message. The "other agents here" line tells the agent to use `ask_agent` instead of telling the person to go ask.

## Consequences

- Costs go up only when agents are actually picked. Every agent message without mentions costs one router call (Jev ≈ free, LLM fallback a cheap model). Consulted runs bill to the consulted agent's budget as usual.
- The agents' DM is invisible in the app for now. An audit view ("see the conversation") can come later from `agent_consultations`.
- The UI for the "message from @agent" card and the grouped "Theo, Iris and 2 more are working…" indicator comes after a prototype is approved.
- A consulted run that pauses for an approval keeps the consultation open; the asker resumes when that run ends or when the 15 minutes run out.

## Addendum (2026-10-18): addressees, no duplicate requests, on-behalf-of authority

Incident (#tech): "@atlas, when an error comes in ask @ada to analyze it and write a technical analysis on the issue" started both agents (each @ starts a run). Atlas updated its routine and answered. Ada, in parallel, asked Atlas privately to update the routine; in that consultation Atlas's routine tools refused ("only a person's direct request"), and its reply was surfaced next to its own "done". Ada then said the two answers contradicted and that it couldn't read Atlas's routines.

**1. Addressee vs referenced.** A person's message that mentions two or more agents of the channel is classified before the insert (`classifyAddressees` in `messages.ts`, `personMentionAddressees` in `judge.ts`): one Noul per mentioned agent, "is the person asking this agent to act or answer now?". Agents at or above `ADDRESSEE_THRESHOLD` (0.5) get a run; the others are *referenced*: stored in `meta.referencedAgentIds`, no run, no steering of their active run, excluded from the `message.posted` safety net. The acting agent's prompt says who is only mentioned. Fail-open: no judge, an error, `ADDRESSEE_TIMEOUT_MS` (2.5 s), or nobody above the threshold keeps the previous behaviour (every mentioned agent acts). One mention never calls the judge. The decision is stored in `routing_decisions` (`addressees-<judge>`). Receipts carry `referenced` (list API and `message.routed`); the app shows "Only mentioned" and never "nobody will answer" because of it. A mention run now also hears which other agents got the same message (the routing decision's `selected`), as router runs already did.

**2. No duplicate requests.** `ask_agent` checks the target agent's runs first: a run on the asker's trigger message (active or done), or an active run in the asker's thread, means the person already asked it. No consultation is created; the asker gets "@x is already working on this person's request (run …); wait for its answer" or the answer it already gave (`data.duplicateOf`). The tool description and the "other agents here" prompt line say not to relay to an agent what the person asked it directly.

**3. On-behalf-of authority.** Tools that need a person's request (routines and reminders, `schedule-tools.ts`) resolve the person with `personBehindRun` (`requester.ts`): the trigger's author when a person wrote it; for a consulted run, the person at the root of the chain, following only consultation links, each checked against `agent_consultations` (message, asking run). No person at the root, no authority. The consulted agent still acts within its own scopes and the person's permissions (`requireRoutineEditor`). A routine or reminder created inside a consultation lands in the conversation where the person asked (`consultationOrigin`), not in the agents' DM. The consulted agent's prompt says it acts for the person behind the request.

**4. Reading across agents.** `list_routines` takes `agent` (a handle, or `all`) and `id`: any agent reads the org's routines to verify. Instructions are hidden when the routine answers in a private conversation that neither the reading agent nor the person is in; agents the person can't talk to (D31) are left out. Editing stays with the routine's own agent; `update_routine` on another agent's routine is refused with a clear message. `issues:read` joins the default scopes of new agents (`issues:write` already implied it).

**5. Surfacing.** With 2 and 3 the contradictory consultation reply no longer happens. Not done: replacing a surfaced consultation card with the latest state when the consulted agent's direct answer in the channel says otherwise.

Evals: `ops-addressee-routine-mentions-other-agent`, `ops-consulted-on-behalf-edits-routine`, `dev-reads-other-agent-routine` (`packages/engine/eval/behavior-cases.json`; the harness now seeds other agents, routines and consultations).

