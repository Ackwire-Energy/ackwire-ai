# 0013. Router: code picks candidates, a strategy scores them, policy decides

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D5 and roadmap step 2. Extends 0008.

## Decision

A person's message without mentions enqueues `message.posted`; the handler calls `routeMessage` when `ROUTER_ENABLED`. Agent messages never go through the router (D5 default).

1. **Candidates are chosen by code**: active agents that are members of the channel with `channel_members.auto_reply = true`. Nothing else can be picked.
2. **A `RouterStrategy` only scores them**: `decide({ orgId, channel, message, thread, candidates }) → { agents: [{ agentId, score }], needsAgent?, reason?, usageRecordId? }`. It never adds candidates or grants anything.
3. **Policy is applied by code** (`selectAgents`): drop scores below `ROUTER_MIN_SCORE` (default 0.5), nobody if `needsAgent` is below it, best first, at most 2. The hop limit is checked before routing.
4. Runs are created with the shared `createAgentRuns` helper (trigger `router`), the same one mentions use.
5. **Every decision is stored** in `routing_decisions` (unique per message): strategy name, every candidate's score, the need-any-agent score, who was picked, the reason, the usage record. That makes strategies comparable later.

**Core strategy (`llm`)**: one structured-output call through `gateway.complete` (kind `router`, billed to the org's credential), `effort: "low"`, JSON Schema output whose `handle` field is an enum of the candidates. The model is `organization_settings.router_model` or the deployment's `ROUTER_MODEL`. Message text is wrapped as data. Malformed output means nobody answers.

**Failures**: transient errors rethrow (outbox retry); permanent ones (no credential, rejected request) or the final attempt store a decision with `error` and pick nobody.

**Other strategies** plug in through `JobDeps.router.strategy`. Planned: an optional external classifier (TypeSafe Jev, `POST https://api.typesafe.ai/v1/systemone`, one question per candidate plus "does this need any agent?"), enabled by env only, never required, and recording its usage like every other model call.
