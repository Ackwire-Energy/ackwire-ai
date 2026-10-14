# 0005. Postgres outbox and in-process workers, no Redis/BullMQ

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D18. Same approach as Tierbird ADR 0010. Supersedes the BullMQ mention in D3 and in the "Infra" table of planejamento.

## Decision

- One table, `outbox`, is both the transactional outbox and the job queue. Rows are written in the same transaction as the change that causes them (`enqueue(tx, …)`): a message and its `message.posted` event commit together or not at all.
- Workers claim due rows with `SELECT … FOR UPDATE SKIP LOCKED` and set a lease (`locked_until`, default 10 minutes, longer than any model call we allow). An expired lease makes the row claimable again (crash recovery). Completion is fenced by `locked_by`, so a late worker can't overwrite the new owner.
- Failures retry with backoff (5 s → 3 h) up to `max_attempts`, then the row is `failed`. Handlers throw `PermanentJobError` to skip retries; errors with `retryable: false` (e.g. provider auth errors) also stop. Handlers get `finalAttempt` so they can fail cleanly.
- Optional `dedupe_key` (unique) makes enqueueing idempotent.
- Workers run inside the server process (`apps/server/src/workers.ts`): the outbox every second (plus `wake()` right after a post with mentions), message partition maintenance daily. Safe on several replicas.
- Job kinds today: `message.posted` (dispatch @mentions) and `agent_run.execute`.

## Consequences

- Self-host stays one container + Postgres.
- Handlers must be idempotent (a job can run twice after a lease expiry). Ours are: runs are unique per (trigger, agent) and the run state machine uses compare-and-set.
- If Cloud ever needs more throughput: tune batch size, adopt pg-boss, or add a Redis-backed module in the cloud repo. The `outbox` contract stays.
