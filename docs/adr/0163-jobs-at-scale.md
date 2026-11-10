# 0163. Jobs at scale: workspaces take turns, runs sized by memory, worker processes

- Status: Accepted
- Date: 2026-11-09
- Amends: 0053 §10 (its addendum of 2026-11-09), 0005 (how the outbox claims)
- Code: engine `outbox.ts` (`claimWhere`, `FAIR_SCAN`, `laneLimits`, `resizeLanes`, `laneAlarm`, `claimLaneAlarm`,
  `RUN_MEMORY_BYTES`), `cache.ts` (`shareCacheInvalidations`); db `client.ts` (`MIGRATIONS_LOCK`); server
  `start.ts` (`SERVER_ROLE`, the lanes' limits at boot), `workers.ts` (the late beats, `slowLaneMessage`),
  `routes/health.ts` (`workerHealth`); config `OUTBOX_MAX_IN_FLIGHT_CEILING`, `SERVER_ROLE`; tests `outbox.test.ts`,
  `run-cost.test.ts`, `cache-share.test.ts`, db `migrate-lock.test.ts`

## Context

ADR 0053's addendum of 2026-11-09 split the job pump into a quick lane and a long one, and let the slots grow while
jobs wait, but no further than 4 jobs per database connection: 64 slots by default. More people would bring the same
waits back. Claims were also first come, first served across workspaces, so one workspace firing hundreds of routines
made every other workspace's routines wait behind them.

## Decision

1. **Workspaces take turns.** In each lane, a claim ranks the due jobs per workspace, oldest first, after the jobs of
   that lane the workspace already runs on any process (`processing`, lease live), and takes the lowest ranks: round
   robin, with credit for what each one holds. One workspace's burst queues only that workspace; a workspace alone
   uses every slot; a job of no workspace (an email to an address) is a turn of its own (`coalesce(org_id, id)`).
   The ranking runs in materialized CTEs without locks (a window function can't take `FOR UPDATE`); the outer select
   locks with `FOR UPDATE … SKIP LOCKED` and checks the due condition again. It covers a lane's 10,000 oldest due
   jobs (`FAIR_SCAN`); a backlog past that is more than the workers can run, and the alarm says so.
2. **Runs hold no database connection while they wait.** Every transaction in the engine and the server (350 sites)
   was scanned for anything awaited besides the database, and the flagged ones read: none waits on a model, a tool
   or a computer. The gateway reserves the budget, streams outside any transaction, then settles; a call to a computer
   held by another process polls its `machine_rpc` row in short reads; secrets are sealed before their transaction.
   So the database bounds only the quick lane, and memory bounds the long one.
3. **Lanes sized by what bounds them.** Quick jobs read and write more than they wait: at most 4 per connection
   (`DATABASE_POOL_MAX`) run at once, claims included. Measured by `run-cost.test.ts` (100 real runs through the
   executor and the gateway, the fake model held after its first words, PGlite in the same process): a waiting run
   holds about 115 KB of heap; with all 100 waiting, timers fire at most 2 ms late; a run's whole life costs about
   47 ms of CPU, the database's work included. `RUN_MEMORY_BYTES` assumes 4 MB, and the long lane grows to as many
   runs as half the process's memory holds beside what it held at boot (`process.constrainedMemory()`: the
   container's limit on Linux): about 400 on a 4 GB container, about 1,900 on 16 GB. Runs that hold far more (images)
   meet the live brake below. `OUTBOX_MAX_IN_FLIGHT_CEILING` is now optional, a cap over both lanes. On the built-in
   database the slots stay where they start.
4. **Growth, and what stops it.** Every 30 s, a lane whose jobs waited over 2 s doubles, within its limit and the
   total's, quick first; one that waited for nothing and used half its slots or fewer halves, never below where it
   started. Nothing grows while the processor is busy (over 30 of the step's 300 timer beats late by 100 ms or more,
   each beat a long block swallowed counted), the database is slow (a `select 1` over 100 ms, waiting for a
   connection included) or the process holds over 70% of its memory; past 85%, the long lane halves.
5. **Worker processes.** `SERVER_ROLE=worker` runs the jobs and the timers, with no app, API, sockets, operator API
   or usage report; over HTTP it answers `/api/health` alone, so its container turns healthy and a deploy that waits
   for it goes on. Every process claims from the same queue without two holding a job at once (a job whose process
   stopped mid-way runs again once its lease ends), and the turns count every process's jobs. A worker reaches
   computers through the process that holds their socket (`machine_rpc`). PostgreSQL only.
   - Migrations: processes booting together take turns on an advisory lock (`MIGRATIONS_LOCK`, on a connection of
     its own): drizzle's migrator takes none, and two of them would both apply, and both record, a migration with no
     DDL, which every later boot then refuses. A worker may leave them to the app (`RUN_MIGRATIONS_ON_BOOT=false`).
   - Caches: an invalidation of the per-process caches (scopes, members, credentials, settings) made in one process
     is published over the Postgres pub/sub and applied in every other one, which never publishes it again.
   - The way to scale: when jobs keep waiting, add a worker process (SELF_HOSTING.md, "More at once: worker
     processes"). Each one adds as many jobs at once as the app runs, with its own `DATABASE_POOL_MAX` connections
     and one it listens on.
6. **Told when to add one.** A lane whose wait (the p90 of its claims, or its oldest job still due) stays over its
   threshold for 5 minutes (quick jobs 5 s, agents' runs 30 s, routines 5 minutes) goes to the error reporter,
   naming the lane and saying to add a worker process, or, on the built-in database, to raise `OUTBOX_MAX_IN_FLIGHT`
   or move to PostgreSQL. Once per lane and hour across every process: the first to record it tells (a finished
   outbox row keyed by the lane and the hour). No page shows it: none shows the job queue today.

## Consequences

- A claim reads up to 10,000 due rows of its lane and ranks them: milliseconds at today's backlogs, bounded at worse.
- Turns count jobs, not their length: a workspace keeps the slots its long runs hold, and the next free slot goes to
  whoever holds fewer.
- One process may run hundreds of agents' runs at once. Model providers' rate limits apply to each workspace's own
  keys, and computers keep their own lines.
- Tests: a workspace running jobs on another worker claims after one running none; jobs of no workspace take their
  own turns; one workspace's burst of 20 routines leaves another's 3 their turns; two pumps on one database never
  claim a job twice and share the turns; quick jobs stay within their lane's limit; each brake and the shedding;
  one alarm per lane and hour; a run's cost under its budget; cache invalidations across processes; the worker's
  health check. On a real server only (`TEST_DATABASE_URL`): a claim skips the jobs another worker is taking, and
  processes booting together record each migration once.
