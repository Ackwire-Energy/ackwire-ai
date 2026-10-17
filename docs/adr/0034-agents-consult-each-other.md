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
