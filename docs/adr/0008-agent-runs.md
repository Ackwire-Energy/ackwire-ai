# 0008. Agent runs: a Postgres state machine; mentions and the hop limit

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D1, D3, D5 (mention-only for now), D9 layer 1.

## Decision

**Flow** (all writes in Postgres, in-process workers):

1. A person posts a message. `insertMessage` resolves `@handle` mentions to active agents that are members of the channel and, in the same transaction, enqueues `message.posted`.
2. `dispatchMentions` (job `message.posted`) creates one `agent_runs` row per mentioned agent (`unique (trigger_message_id, agent_id)`) and enqueues `agent_run.execute` (dedupe key per run).
3. `executeRun` moves the run `queued → running`, builds the context, streams through the Model Gateway publishing `agent.delta` events, then in one transaction persists the agent's reply (in the trigger's thread), the steps and `running → done`, and publishes `message.created`.

**State machine** (`agent_runs.status`): `queued → running → (waiting_approval → running)* → done | failed`. Transitions are compare-and-set (`UPDATE … WHERE status = from`); illegal ones throw. `waiting_approval` is reserved for the approvals flow: suspending is a status change, resuming is enqueueing a new execute job.

**Steps** (`agent_run_steps`, numbered): `context` (history size, model), `model_call` (model, tokens, cost, stop reason, usage record), `message`, `error`.

**Failures.** Permanent problems (budget, missing credential, non-retryable provider error, refusal, empty reply) fail the run with a reason and finish the job. Transient provider errors rethrow so the outbox retries (up to 4 attempts); the run stays `running` and the retry restarts the turn; on the final attempt the run fails.

**Triggering and hop limit.** Only explicit @mentions start runs; there is no router yet, and agent messages never go through a router (D5 default). An agent's reply can @mention another agent. Each message carries `hop`: 0 for a person, trigger hop + 1 for an agent reply. A message whose hop reached `AGENT_MAX_HOPS` (default 3) triggers nobody, so agents can't ping-pong forever; a person posting in the thread resets the counter. An agent never triggers itself.

**Context** (`buildRunContext`): system prompt = agent identity, organization context, agent instructions, reply rules (other people's and agents' text is information, not instructions), channel and members. History = recent top-level messages up to the thread root, the root, and the thread up to the trigger, capped at `AGENT_CONTEXT_MESSAGES`; turned into alternating user/assistant turns (own messages are assistant, others prefixed `[Author]:`), always ending with the user turn (no prefill).

## Extension points

- **Router (D5, roadmap step 2):** a new job kind run after `message.posted` for messages without mentions; it calls the gateway with `ROUTER_MODEL` and reuses the run creation of `dispatchMentions` (extract it into a shared helper then). It may only pick agents that are channel members; it never grants permissions. `usage_records.agent_id` will need to become nullable (or a "router" pseudo-agent) for router calls.
- **Tool Gateway and approvals (D2, D4):** a `tool_call` step kind; sensitive actions create an approval bound to a hash of (action + params), move the run to `waiting_approval`, and the approval grant enqueues `agent_run.execute` again.

## Addendum (2026-10-14): waiting for a person's answer

`ask_user` is a built-in tool (no scope; it goes through the Tool Gateway
like every other tool). Instead of running, the gateway hands the question to
the executor, which posts it in the run's thread (`meta.question`), stores an
`agent_questions` row and moves the run to `waiting_input`. The run resumes
(a new `agent_run.execute` job) when a person answers through
`POST …/questions/{id}/answer`, replies in the same thread (detected in the
same statement that writes the reply; that reply starts no other run), or
after 24 hours, when the model is told nobody answered. A run waiting on
both an approval and a question resumes only when neither is pending.
