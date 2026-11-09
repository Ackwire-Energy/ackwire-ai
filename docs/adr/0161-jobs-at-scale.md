# 0161. Jobs at scale: workspaces take turns, runs sized by memory, worker processes

- Status: Accepted
- Date: 2026-11-09
- Amends: 0053 §10 (its addendum of 2026-11-09), 0005 (how the outbox claims)
- Code: engine `outbox.ts` (`claimWhere`, `FAIR_SCAN`, `laneLimits`, `resizeLanes`, `laneAlarm`,
  `RUN_MEMORY_BYTES`); server `start.ts` (`SERVER_ROLE`, the lanes' limits at boot), `workers.ts` (the timers' beat,
  `slowLaneMessage`); config `OUTBOX_MAX_IN_FLIGHT_CEILING`, `SERVER_ROLE`; tests `outbox.test.ts`, `run-cost.test.ts`

## Context

ADR 0053's addendum of 2026-11-09 split the job pump into a quick lane and a long one, and let the slots grow while
jobs wait, but no further than 4 jobs per database connection: 64 slots by default. More people would bring the same
waits back. Claims were also first come, first served across workspaces, so one workspace firing hundreds of routines
made every other workspace's routines wait behind them.

## Decision

1. **Workspaces take turns.** In each lane, a claim ranks the due jobs per workspace, oldest first, after the jobs of
   that lane the workspace already runs on any process (`processing`, lease live), and takes the lowest ranks: round
   robin, with credit for what each one holds. One workspace's burst queues only that workspace; a workspace alone
   uses every slot. The ranking runs in materialized CTEs without locks (a window function can't take `FOR UPDATE`);
   the outer select locks with `FOR UPDATE … SKIP LOCKED` and checks the due condition again. It covers a lane's
   10,000 oldest due jobs (`FAIR_SCAN`); a backlog past that is more than the workers can run, and the alarm says so.
2. **Runs hold no database connection while they wait.** Every transaction in the engine and the server (350 sites)
   was scanned for anything awaited besides the database, and the flagged ones read: none waits on a model, a tool
   or a computer. The gateway reserves the budget, streams outside any transaction, then settles; a call to a computer
   held by another process polls its `machine_rpc` row in short reads; secrets are sealed before their transaction.
   So the database bounds only the quick lane (4 jobs per connection) and memory bounds the long one.
3. **The long lane is sized by memory.** Measured by `run-cost.test.ts` (100 real runs through the executor and the
   gateway, the fake model held after its first words, PGlite in the same process): a waiting run holds about 115 KB
   of heap; with all 100 waiting, timers fire at most 2 ms late; a run's whole life costs about 47 ms of CPU, the
   database's work included. `RUN_MEMORY_BYTES` assumes 4 MB, about 35 times the measure, for long transcripts and
   images. The long lane grows to as many runs as half the process's memory holds beside what it held at boot
   (`process.constrainedMemory()`: the container's limit on Linux, the machine's memory otherwise): about 400 on a
   4 GB container, about 1,900 on 16 GB. `OUTBOX_MAX_IN_FLIGHT_CEILING` is now optional, a cap over both lanes. On
   the built-in database the slots stay where they start.
4. **Growth.** Every 30 s, a lane whose jobs waited over 2 s doubles, within its limit and the total's, quick first;
   one that waited for nothing and used half its slots or fewer halves, never below where it started. Nothing grows
   while timers fire over 200 ms late (a 100 ms beat, `LOOP_LAG_MAX_MS`): on a busy processor, more jobs would only
   wait on it.
5. **Worker processes.** `SERVER_ROLE=worker` runs the jobs and the timers with no HTTP, sockets, operator API or
   usage report. Every process claims from the same queue without overlap, and the turns count every process's jobs;
   a worker reaches computers through the process that holds their socket (`machine_rpc`). PostgreSQL only. The way
   to scale: when jobs keep waiting, add a worker process (SELF_HOSTING.md, "More at once: worker processes"). Each
   one adds as many jobs at once as the app runs, with its own `DATABASE_POOL_MAX` connections.
6. **Told when to add one.** A lane whose wait (the p90 of its claims, or its oldest job still due) stays over its
   threshold for 5 minutes (quick jobs 5 s, agents' runs 30 s, routines 5 minutes) goes to the error reporter, naming
   the lane and saying to add a worker process; at most once an hour per lane. No page shows it: none shows the job
   queue today.

## Consequences

- A claim reads up to 10,000 due rows of its lane and ranks them: milliseconds at today's backlogs, bounded at worse.
- Turns count jobs, not their length: a workspace keeps the slots its long runs hold, and the next free slot goes to
  whoever holds fewer.
- One process may run hundreds of agents' runs at once. Model providers' rate limits apply to each workspace's own
  keys, and computers keep their own lines.
- Tests: two pumps on one database never claim a job twice and share the turns; one workspace's burst of 20
  routines leaves another's 3 their turns; `resizeLanes`, `laneLimits` and `laneAlarm` cases; a run's cost under its
  budget.
