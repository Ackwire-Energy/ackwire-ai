# 0121. Long work that takes itself home

- Status: Accepted (built)
- Date: 2026-11-02
- Supersedes: ADR 0045 (background work, proposed and never built). Takes only ideas from the unmerged draft on `feat/agents-find-a-way` (ADR 0099 § Background work).
- Extends: ADR 0008 (runs), 0032 (brains), 0084 (agent status), 0089 (stretches), 0095 (hand-offs), 0097 (`decideTurnEnd`), 0112 (steering), 0114 (Cursor), 0118 (usage pause)
- Code: `packages/engine/src/works.ts` (move, updates, check-in job, queue, end, reconcile, views), `work-tools.ts` (the four tools), `executor.ts` (adoption, safety net, queue park, job yield, report home, wait/end hooks), `messages.ts` / `dispatch.ts` / `run-scope.ts` (`workKeepsThread`), `brains/select.ts` (`sessionFor`, `mayFallBack`), `agent-status.ts` (`work` line), `working.ts`, `recovery.ts` (`activeRunsIn`), `issues.ts` (`linkIssueToWork`, `setWorkIssueState`, `shareIssueWithEveryone`, `blocked`, `backgroundWork`), `notification-producers.ts`, `cancel.ts`, `continue-run.ts`, `context.ts` (prompt line, "# Your background work here"), `context/learn.ts`, `usage-pause.ts`, `notices.ts`, `events.ts` (`agent.work`); server `routes/app/issues.ts` (`POST …/issues/{id}/share`), `schemas.ts` (`WorkView`), `workers.ts` (sweep), `engine.ts`; client `lib/long-work.ts`; ui `components/WorkLine.tsx`; web `components/BackgroundWork.tsx`; phone `features/chat/WorkLine.tsx`; migration `0174_background_work.sql`; env `AGENT_WORK_MAX_PER_ORG`

## Context

- **One run holds the conversation.** An agent has one active run per conversation (`startOrJoinRun`, the `active` CTE of `insertMessageWithRuns`). A 40-minute task kept the working bar spinning for 40 minutes, and the agent couldn't answer side questions there.
- **`agent_runs.background` is a routine's run**: no person behind it, it never posts, it never falls back to the API. It can't be reused for a person's work.
- **Brains run long work differently.** The API model runs the loop; Claude Code keeps one process per (agent, session) and a single turn can last the whole job; Codex uses app-server threads; Cursor runs one `agent -p` per turn.
- **Live steering** reaches Claude Code at its next tool boundary and Codex app-server at its next model request; Cursor and the API model read messages at their next step.

## Decision

### 0. The same run steps out of the conversation

Going to the background starts no child run: the run already working keeps going and stops holding the conversation's slot. Permissions, audience, scopes, budget and the person behind it stay the same, the computer brain's session and process carry on mid-turn, and cards, hand-offs, proof and the controller keep working unchanged.

`moveToBackground` (`works.ts`), in one transaction: locks the run and claims it (`work_id is null`), posts the **anchor** where the run answers now (the agent's `say`, or on an automatic move the `work_auto_moved` body code with the workspace language's words as the fallback; `meta.longWork = { id, auto? }`), inserts the `agent_works` row and, for an ask in a main timeline, makes the anchor the run's thread (`own_thread`). Asked inside a thread, the thread stays (threads don't nest). It then publishes the anchor, `agent.work`, an `agent.idle` marked `background` (the apps drop the run's live bubble) and a message on `run-work:{runId}` so the executor holding the run adopts it even when the tool ran through the bridge on another replica. The executor's `replyThreadId`, `where`, `ctx.threadRootId` and its events' `background` mark are mutable and follow the move.

`meta.work` already names a reply's tool block, so the anchor's meta is `longWork`; updates carry `workUpdate`, ends `workEnd`.

### 1. When work becomes background work

- **The agent decides**: `work_in_background({ title, say, next_update_minutes?, plan?, card?, card_issue?, description? })`, through the tool gateway and so the MCP bridge on every brain. Listed only for a run a person is behind (`runAuthority` → `person`), in a channel or DM people read, never in a mission's thread, a forum turn, an agents' DM, a routine's run or a run that already is a work (`workEligible`). The prompt line (`WORK_IN_BACKGROUND_LINE`) goes in "How you work" when the tool is there.
- **The safety net is deterministic**: a timer per execution attempt (`autoMove` in the executor) counts active time (`transcript.activeMs` across parks, waits excluded) and model calls, and moves an eligible run at `WORK_AUTO_AFTER_MS` (4 min) or `WORK_AUTO_AFTER_CALLS` (20), concurrently with a long computer turn. Its title is the thread's, else the excerpt of the ask. The note reaches the brain like a check-in (an agent-only `work_check_in` notice, live on a steerable turn).

### 2. Every brain, one surface

The same tools everywhere (`work_in_background`, `post_update`, `steer_work`, `stop_work`) and the final message as the report. `post_update` is listed with `work_in_background` (a CLI lists its tools once per process) and refuses until the run is a work.

- `sessionFor`: a conversation run never takes a session that a work run or an active run shares, through any row that carries it (an earlier finished run included).
- A work's turn end drops the check-ins it never read (agent-only `work_check_in` notices, `dropWorkNotices`): the turn's text is the report. A work still in line at a turn's end parks there (`workStartsNote` when its turn comes), never ends `done`.
- `mayFallBack`: a work waits for its computer instead of switching brains.
- No runner change and no protocol bump.
- An API-model work yields its job after `WORK_JOB_YIELD_MS` (1 h) at the loop top: it saves its transcript and queues its own `agent_run.execute` 10 s later. A single computer turn longer than the outbox's 6 h lease stays the known ceiling.

### 3. Progress updates

- Updates go to the anchor's thread (or the ask's thread); the report goes **home** (`home_thread_id`) as a normal reply with `meta.workEnd = { id, status }`.
- `post_update({ text, next_update_minutes?, plan?, important? })`: plain text ≤ 500, credentials masked; 5 min between updates unless `important` (then 1 min); the promise clamped to 5–20, default 10.
- **Check-in** (`agent_work.check_in`, deduped by work, seq and due time): a nudge the agent alone reads, then after `graceMs` (3 min) the server's own update (`work_auto_update`, worded from the run's automatic status line), and a new promise in 10 min; compare-and-set on `update_seq`; the fallback carries the promise it was queued for (`due`), so a wait that restarted the timer drops it. A work 15 min old without a card gets one from its own `card` check-in, queued at the move, whatever its updates did.
- **Waiting** (approval, question, usage pause, its computer, the line): `next_update_at` is null and no timer runs (`pauseWorkTimer` from `finished`); the card that stopped it is the update; on resume the promise starts over with 10 min (`resumeWorkTimer`).
- The report notifies the person behind it as news of its own (`work_end:{id}` group, so it pushes); updates never notify; the asker follows the anchor's thread.

### 4. Tasks board

A card when the agent sets `card` (or names one with `card_issue`), when the run already works on an issue, or when a live work reaches 15 min. An existing issue is linked, its `criteria` untouched. A new card: the work's title, the agent's description or the excerpt of the ask, assigned to the agent, `source = { type: "agent", workId, channelId, messageId }`, `channel_id` = the conversation's (seen by who reads it; **Mostrar para todos** clears it: only a work's card, by who asked for the work, the card's creator or an admin, with a `shared_everyone` activity line; the apps offer it only for a DM's or a private channel's card). `card_issue` links only a card the asker can read, in the work's conversation or workspace-wide; otherwise a new card is made.

| Work | Issue status | Blocked badge |
|---|---|---|
| Queued | `todo` | – |
| Working | `in_progress` | – |
| Waiting on a person, paused, its computer | its stage | `issues.blocked = { reason, since }` |
| Failed | its stage | `{ reason: failed, text: errorCode }` |
| Done | `done` (or kept `in_review`) | cleared |
| Stopped | `todo`, activity "work_stopped" | – |

Every update is an `issue_activity` event `work_update`. The plan (`[{ id, text, state }]`) shows as "Plano do agente", apart from the people's criteria. `IssueView` carries `blocked` and `backgroundWork` (the work's view).

### 5. Agent status

`AgentStatusKind` gets `work`; `AgentStatusLine` gets `since`, `count`, `second` and `wait`. Precedence: the agent's own words > its works > a conversation run's line > wait lines. A title shows only where everyone may read it (a public channel); elsewhere the line says "Trabalhando em segundo plano". A live work makes the agent busy. `listWorkingRuns` carries `work` (title, plan progress, since); `workingNow` makes it `kind: "work"`.

### 6. Conversation UX (web and phone)

- Work runs never drive the conversation's working bar: their events carry `background`, and `activeRunsIn` marks them so.
- The anchor's **WorkLine** (`packages/ui`, phone `features/chat/WorkLine.tsx`, one view model `workLine` in `packages/client/src/lib/long-work.ts`): "Em segundo plano · 12 min · próximo update em ~8 min", the queue, "Aguardando sua aprovação", "Pausado no limite do plano · volta às 14:00", "Terminou em 38 min", "Não terminou", "Parado por Bia aos 12 min"; the last update as a second line; Abrir thread (only where no thread line already opens it), Tarefa #42, Ver resultado, Parar. Plain text that wraps.
- The agent stays free: an own-thread work no longer matches the join rules, and an in-thread work is excluded explicitly (`workKeepsThread` in the `active` and `floor_runs` CTEs and `startOrJoinRun`). A reply in the anchor's thread joins the work run (live on steerable brains).
- A new run in the conversation reads "# Your background work here" and has `steer_work` (forwards the person's messages unchanged into the work's inbox, live when it can) and `stop_work` (through `cancelRun`, so `mayStopRun` decides).
- **Parar** calls `POST …/runs/{runId}/cancel`; who may is computed by the apps as for any run (who asked, the agent's owner, an admin); the line is broadcast to everyone, so it can't carry a per-reader flag, and a refusal shows as a toast. `stopRun` closes the work home at once ("Parado por …").

### 7. Limits and safety

- Caps (counted under a per-workspace advisory lock): 3 live works per agent (`WORK_LIMITS.perAgent`), `AGENT_WORK_MAX_PER_ORG` (default 10) per workspace. Past a cap the move still happens and the work is `queued`: its run parks at the loop top (`waiting_input`, `waitingForBrain.code = "work_queue"`); ending any work releases the oldest that fits (`releaseQueuedWorks`) and queues its run; a run released while it parked wakes itself.
- Usage (ADR 0118): a work is long work by kind; in `usageWaitPlace` works go after conversation runs and before routines.
- Budget, the tool-call backstop and stretches apply unchanged. `continueRun` carries `work_id` and reopens the work in its own thread.
- A run that ends `done` without finishing (out of steps, stuck, its brain cut off) posts its closing line home with `meta.workEnd = { status: failed, errorCode }` (`run.too_many_tool_calls`, `run.stuck`, `run.brain_interrupted`); `endWork` takes that status. Its wrap-up note asks for the report (`WRAP_UP_WORK_NOTE`). The call count moves a run only after 90 s of active time (`WORK_AUTO_MIN_MS`).
- Failure: the end goes home with `meta.workEnd = { status: failed, errorCode, errorParams, lastUpdate }` (a stop: `byUserId`, and `bodyParams.byName`), worded by the apps (`workEndBody`), the card gets the blocked badge, `run_failed` notifies as before.
- Restarts: a work run is an ordinary run for `recoverStaleRuns`; check-ins are outbox jobs; the recovery worker also runs `reconcileWorks`, which closes once (`finished_at is null`) a work whose run is terminal and releases what fits.
- No duplicates: updates are tool calls in the one executor holding the lease; the fallback and the agent's update race on `update_seq`; the end on `finished_at`; the move on the locked run with `work_id is null` and the unique anchor.
- Learning (ADR 0120) ignores work runs when it checks whether the agent still works in that conversation.

### 8. Data

Migration `0174_background_work.sql`: `agent_works` (with `org_id`, `anchor_message_id` unique, partial indexes on live and queued), `agent_runs.work_id` (FK, set null on delete; partial index), `issues.blocked`. The work's current run is its newest run with that `work_id`.

### 9. Tests

`packages/engine/test/works.test.ts` (move and freed conversation, flat DM, in-thread ask, steering and `stop_work`, the safety net by time and by calls, check-in nudge/fallback/race/redelivery, update gaps and clamps, waits, cards and their stages, the 15-minute card, caps and the queue, the workspace cap, the sweep twice, status lines, Continuar), `engine-brains.test.ts` (a steerable brain gets the check-in live and keeps its session while a conversation run gets another; a brain that reads at its turn's end gets it next turn and the server's line covers the silence), `apps/server/test/long-work.test.ts` (the anchor's view, `agent.work`, `background` in active runs, Parar refused to others and closing it home), `apps/mobile/test/features/long-work.test.ts` (every line state in both languages, status lines, badges, server bodies, `workingNow`).

### 10. The owner's decisions (2026-11-02, approved as recommended; ADR 0124)

- **A card from a DM or a private channel stays private** to who reads that conversation; Mostrar para todos stays the way to show it to everyone (`works.test.ts` holds it).
- **Continuar after a provider error**: a work whose run failed with `run.provider_error` or `run.provider_unavailable` shows Continuar under its end (`workContinuable` in the apps; `continueRun` takes the work's `result_message_id` and marks `meta.workEnd.continuedRunId`). It carries the same work, as Continuar at the step limit does.
- **A finished anchor keeps no promise**: the line says "Terminou em N min" (or the failed or stopped wording), the anchor's text is dimmed, the server's automatic anchor shows its words without the next update (`work_auto_movedOver`), and an agent's anchor drops a last sentence that promises a time (`workAnchorBody`). `say` no longer carries a time: the line under it does.

## Left out

- Works for unattended runs and for missions (missions keep their own plan and progress).
- A Bloqueado column: a badge for now; one enum value later if wanted.
- "Continuar agora" on the paused line: the usage pause card in the work's thread has it.
