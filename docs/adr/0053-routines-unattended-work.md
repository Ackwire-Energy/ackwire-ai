# 0053. Routines and unattended work: safe and dependable on every brain

- Status: Accepted
- Date: 2026-10-23
- Planning: D82
- Builds on: ADR 0032 (one engine, swappable brains), ADR 0034 (agents consult each other), ADR 0037 (agents investigate first, act with undo), the chat-delivery work (background runs, `hand_off`, run inbox)
- Evaluates: ADRs 0045–0052 and the `feat/agent-runtime` branch (taken where they fit, see the end)
- Code: `packages/engine/src/authority.ts`, `routine-brief.ts`, `routine-ledger.ts`, `untrusted.ts` (the shared base this ADR builds on)

## Context

Routines are agents working while nobody watches: Theo's daily analytics and a 30-minute review check, Lisa reading a customer inbox every hour, Ada doing the issues assigned to her and opening PRs, Atlas checking Sentry every hour. In production almost every routine runs on Claude Code on someone's Mac, not on the API. The delivery model built for chat (a silent background run that speaks only through `hand_off`, which wakes a normal run of the same agent that tells people in its own voice) is right and is kept.

An audit of the code (lifecycle, safety, product), of `feat/agent-runtime`, of OpenBot and OpenMausBot, and of how the engine shares one base across brains found:

- **Authority.** A routine's trigger is written as its creator, so every "who asked?" check finds the creator: an unattended run reading a hostile email can rewrite its own routine, post in other channels, DM people and drive other agents with the creator's authority. Only `ask_user` and `react` are refused.
- **Computer brains.** Routine runs get the full "work" profile on a person's Mac. Codex runs with no approvals and no deny list (`approvalPolicy: never`, network on); Claude Code's deny globs can be bypassed and secret files read. Background runs silently fall back to the API brain when the computer sleeps.
- **The ledger.** `routine_runs` closes only on a final answer (564 rows stuck in `started` in a week); stops, failures, deploys and cut-off computer turns leave it open, and some of those paths post into the conversation.
- **Firing.** Nothing stops a routine's runs from overlapping or stacking approval cards; a computer that sleeps leaves an old run waiting and skips every later slot silently (49 skips in a week, nobody told); failures notify on every slot and never pause; `issue.created` routines can trigger themselves; events are neither deduplicated nor coalesced; there is no minimum interval.
- **Noise and privacy.** Every firing writes a line into the conversation that counts as unread for everyone; any member can read every routine's records (customer emails included); notices meant for one agent read as another's own; the agents' DM mixes exchanges done for different people.
- **Engine.** 22 brain-kind branches in `executor.ts`, two paths that post pause cards, the agent's stored brain read where the run's real brain matters, computer sessions keeping a stale system prompt, and no test that runs the same scenario on every brain; evals cover only the API brain.

The product decision stands: a routine thinks with its agent's own brain (Claude Code, Codex or the API), never forced onto the API.

## Decision

### 1. One gate for who is behind a run

`authority.ts` decides, for every brain and every tool, who a run acts for:

| Kind | When | Acts for |
|---|---|---|
| `person` | A person asked, directly or through agents (an agent's message counts for the person behind the run that wrote it; an answer to another agent's question for the person behind the asking run) | That person, within their permissions and the agent's scopes |
| `routine` | A routine's background run | Nobody. Its creator set it up and stays accountable (notifications, approvals) but is never "behind" it; what it may do comes only from the routine's access level |
| `unattended` | No person at the root: the run a routine's report wakes, a note from another agent, an agent's own message, anything they start | Nobody. It reads and talks where it is |

Only authorship and server-set links are followed (a message's run, a notice's `refs.runId`), never message metadata alone. A person writing into an unattended run while it works (`Transcript.steeredBy`) puts them behind it from then on. Every existing "who asked" helper (`requester.ts`, `dispatch.requesterOf`, the ones in chat, schedule, artifact, forum, secrets, team, agent-actions and notification code) delegates to it. `accountablePerson` is whom approvals, questions and failures go to: the person, else the routine's creator, else the agent's owner.

### 2. What each kind may do: one policy table in the Tool Gateway

`tools/run-policy.ts` maps (authority, routine access) × tool to allow, refuse (with a reason the model reads) or approve (forced approval card). The gateway enforces it at listing (refused tools aren't listed) and at every call (defense in depth), so it holds for the API brain and for Claude Code and Codex, which reach our tools through the MCP bridge.

- **Routine runs, any access:** refused, with "put it in hand_off; the people decide": `post_message`, `send_dm`, `share_artifact` to others, `react`, `ask_user`, `schedule_reminder`, `cancel_reminder`, `create_routine`, `update_routine`, `delete_routine`, `run_routine_now`, `ask_agent`, `tell_agent`, forum topics, adding agents or people to channels, `request_secret`, `request_permission`, `request_folder_access`. A routine never manages routines.
- **Routine, access `read` (the default, "Só olhar e contar"):** reads only (built-in reads, connector tools classified as reads, memory/wiki/issue/Drive reads, search) plus `hand_off`. Writes are refused ("this routine only reads: hand off what you'd do").
- **Routine, access `act` ("Pode agir"):** also internal changes people can undo (issues, memory, wiki, Drive files, `git_clone`, work on its own `agentes/<handle>/` branches and PRs). Every write to a connected app becomes an approval card, whatever the agent's own "send without asking" settings say. Sensitive actions (merge, deploy, rollback) are approvals as always.
- **Unattended runs:** reads, the reply where they are, `react`, `pass`, issues and memory with receipts and Undo; connector writes become approvals; refused: posting elsewhere, DMs, routines, reminders, consulting or telling other agents, secrets and permissions. A run a routine's report woke works within that routine's access (`routineAccess`, from the brief its run handed off with): the report of a routine that only looks wakes a run that changes nothing itself and proposes (the issue it would open, with a title); a person's go-ahead puts them behind it. Connector writes still become approvals, asked with the tool itself and its reason, never in words.
- **Person runs:** unchanged.

The mail taint generalizes: any routine or unattended run that sends mail gets a card.

### 3. Computer brains follow the same authority

`apps/server/src/engine.ts` picks the permission profile per turn from the run's authority: `plan` (read-only: no edits, read-only shell, no web fetch or search, no project settings files, our MCP tools only) for routine runs with access `read` and for unattended runs; `work` for `act` routines and person runs. Codex gets the matching profiles: a read-only sandbox without network for `plan`; for `work`, `approvalPolicy: "untrusted"` with every command approval answered by the same command policy Claude Code's permission prompt uses (deny list, read-only allow, forbidden reasons). The command policy is hardened for all runs: secret paths are refused to every read tool our policy sees (one list builds the server's check and Claude Code's own `Read` deny rules, in the home folder and in any project), deny rules match normalized arguments (`gh -R`, `git -c/-C`, `refs/heads/<default>`), interpreter one-liners (`node -e`, `python -c`…) and `gh auth token` are never auto-allowed. Background turns don't keep their computer process alive. An older runner that can't honour a profile fails the turn with `runner_outdated` instead of running with more power: every Codex turn and every Claude Code `plan` turn need protocol 16 (an older runner's plan reads secrets and loads the project's settings files).

In a mission's thread the mission keeps its own profile for its own work, but a run a routine's report or another agent's note woke there gets `plan` like anywhere else.

Codex runs the commands it considers safe (`cat`, `grep`, `ls`…) without asking, inside a read-only sandbox that can read any file the computer's user can: on Codex a secret file can be read even in `plan`, so what holds there is that it can't leave. Its sandbox has no network; every tool call of a run nobody is behind is refused when it carries a credential by its format (keys, tokens, private keys; `tool.credential`), on every brain; and what such a run posts, and a routine's report, have credentials masked. A per-turn Codex permission profile with denied paths (Codex has `default_permissions` and `[permissions.<id>]` profiles) is the next step.

### 4. The routine room, the brief and where a routine delivers

A routine fires a background run in its own room: an agent-only conversation per routine (`routineRoomKey`), hidden from people, from search for other runs and from agents' channel lists. The trigger is the routine's brief, written by its creator, with `meta.routineBrief` (`RoutineBrief`: routine and routine-run ids, name, creator, `deliverTo`, access, report, how it fired, the slot it was due at) and the legacy `meta.routine` `{ id, name, runId }`. The event, when there is one, stays in `routine_runs.event` and reaches the model only inside the outside-content envelope (`untrustedBlock`), never in the brief's text. Nothing of a firing appears in the routine's conversation; the run strip in Rotinas is its history.

The background run's context: the routine block (instructions, access level and what it allows, report policy, slot and how late it runs, the last run's record in the envelope, the event in the envelope) and a read-only view of the recent messages of the conversation it reports to, so it knows what people already said.

`hand_off` delivers its `routine_handoff` notice to `deliverTo` (refs carry `routineId`, `routineName`, `routineRunId`, `runId`), never to the room, at once and once, and only while its routine run is still open (one stopped, replaced or given up meanwhile delivers nothing). Before delivering it re-checks that the routine still exists and is active (a one-off or a manual run counts as live) and that its creator can still post there; if not, the routine run is skipped with the reason and the model is told to finish. The notice wakes an unattended run of the same agent there: it never joins a run working for a person (a person's own words do join; an agent's message for one person joins only a run working for that person; a report or a note joins only a run such news woke), and its text reaches the model inside the outside-content envelope. Approval cards a routine run asks for are posted in `deliverTo`, never in the room.

### 5. The routine ledger

`routine_runs.status`: `queued` → `starting` (claimed) → `started`, then exactly one end: `reported`, `silent`, `failed` (with `code`), `canceled` (a person stopped it), `superseded` (the next slot replaced it while it waited), `missed` (it couldn't run in time); `skipped` when a slot never started a run. `closeRoutineRun` is the only place a routine run ends, called on every ending of a background run: its answer, a failure, a stop, a deploy, a computer cut off, a supersede. A background run never posts by itself on any path (stop, interruption, deploy recovery, approval suspend): the only things a routine puts in a conversation are its `hand_off` notice and its approval cards. A reaper closes rows whose agent run ended and fails `queued` rows whose job died. `routine_runs.brain` records the brain that ran it, `message_id` the agent's message people saw, `finished_at` when it ended.

### 6. Firing rules

In order, for each firing:

1. **Claim** the row (`queued` → `starting`) atomically; transient errors retry the job, permanent ones fail the run.
2. **Structural checks pause the routine** with a coded `paused_reason` and one notification: creator gone or no longer able to post there (`creator_left`, `creator_no_access`), agent archived (`agent_archived`), agent no longer in the channel (`agent_not_in_channel`), audience (`audience`). Removing a member pauses their routines at once. An admin or the agent's owner can take a routine over.
3. **One run at a time per routine.** If the previous run is still queued or working, the slot is `skipped` (`previous_running`). If it waits for a person (an approval or answer) since before the previous slot, it gives way: it is `superseded` (its approvals expire) and the new one starts; otherwise the slot is skipped (`previous_waiting`). Event routines never run in parallel either: events arriving while a run is queued merge into it; while one runs, they gather in one waiting run that starts when it ends.
4. **Computer away.** A background run never falls back to the API brain. It waits for its computer; the next slot supersedes the waiting run (the freshest slot is the one that runs when the computer returns). A waiting run whose slot is more than 12 hours old when the computer returns is `missed` instead of running. The creator and the agent's owner hear it once per outage (grouped, resolved by the next good run), and Rotinas shows "waiting for <computer>". A run that resumes is told its slot and how late it is.
5. **Limits.** A routine that starts agent runs fires at most every 15 minutes (`routine.too_frequent`; reminders are exempt); an agent has at most 20 active routines (`routine.too_many`). Events carry a dedupe key (provider delivery id, issue id): the same event never fires a routine twice. An `issue.created` routine never fires for an issue a routine or unattended run created, and only for issues its creator can see; the event carries the issue id, not its title.
6. **Fatigue.** A failure counts in `failures_in_row`; the first failure after a good run notifies (one notification per routine and streak), the fifth in a row pauses the routine (`failing`) with one notification; a good run resets it.
7. **Stop.** Rotinas has Stop for a running routine (the background run is canceled quietly, the row ends `canceled` with who stopped it); pausing or deleting a routine also stops its run in progress.
8. **Email.** New mail merges only into a queued run whose job is still alive; when an email-triggered run fails or is canceled, its emails are released so the next run gets them.

Schedules keep one semantics for times that don't exist on a DST change (move forward), and an edit keeps the routine's own time zone unless one is given.

### 7. When a routine speaks

`routines.report`: `when_new` (the default: the agent judges; when the instructions ask for a report every time, there always is one) or `always` (a report on every run). With `always`, a run that ends without `hand_off` but with a final text delivers that text as its report (`auto_report`); with no text it fails (`no_report`). The run woken by a report tells people in the agent's voice: how big it is first, the concrete findings (ids, numbers, links) even when it asks for a decision, what it would do, without redoing the routine's lookups; a routine that reports every time keeps the full report. Its message carries `meta.routine` (`id`, `name`, `routineRunId`, `noticeId`) and the routine run records it in `message_id`, so the app shows the message tagged with the routine (the notice it answers folds into it) and Rotinas links each run to it.

### 8. Approvals carry their reason and their origin

Every tool that opens an approval, and `ask_user`, takes a required `why` (what the agent found and why this action), added to the tool's schema by the gateway for every brain and checked on every call (empty or too short is refused with the reason). It is stored on `approvals.why` and shown on the card; the model-only "explain first" nudge is removed. Approvals asked while nobody watched carry `approvals.origin` (`routine` with its name, or `unattended`) and the card and notification say so.

### 9. Privacy

Rotinas shows a routine's prompt, records and reports only to its creator, admins, the agent's owner and the members of the conversation it reports to; everyone else sees its outcomes (ok, silent, failed, skipped) without text, and no prompt for DM, Drive or private-channel routines. A notice is rendered as "yours" only in the context of the agent it is for. In the agents' DM a run only reads exchanges made for the same person, and a question for one person never joins a run working for another.

### 10. One engine, one base

- The run's effective brain is stored (`agent_runs.brain`) and read by shared code (steering, talker, continue, forum budget, outages), never the agent's stored brain.
- Pause cards (approvals, questions, secrets) are posted by one function for the API loop and the bridge, so both carry the same meta, receipts and routine target.
- Computer brains get a "# This turn" block on every turn (now, why they were called, where they are; its fixed part is clipped), followed by the memory and wiki found for the trigger whole on the run's first turn (or a session started afresh); their system prompt holds only what doesn't change during a session.
- Reading a person's message to this agent during a run (one that names it, quotes it, or names no agent) means the run owes them an answer (it can't pass); one addressed to another agent in the same thread is only context. A run that changed something posts its receipts instead of passing; a message read at the tool-call cap is never lost; redispatched messages keep a trigger that matches their author; runs woken by a note may pass, and so may an agent the router brings in on another agent's message about its routine's report.
- A background run near the tool-call cap is asked to hand off what it has instead of failing.
- Background jobs never take more than half of a worker's job slots, so a person's message always finds one; queue waits are measured.

### 11. Product

Rotinas shows per routine: its state (active, paused with the reason and a one-tap fix, failing, waiting for a computer, running with Stop), a week's health ("12 de 14 OK esta semana · 2 puladas"), its access level and report policy in plain words, where it runs ("Claude Code no MacBook do Walter"), its usage (tokens for a plan, cost for the API) and each run with its plain-language outcome and a link to the conversation. The form asks two plain questions: "Quando falar" (toda vez / só quando tiver novidade) and "O que pode fazer sozinha" (só olhar e contar / pode agir). Chat tools create, update, delete (with Undo), run and list routines with these settings, and can set an email or event trigger instead of polling. No internal names in the UI.

### 12. Tests and evals

- A conformance suite runs the same scenarios on the API brain, Claude Code and Codex (fakes at the engine boundary): answer, tool through the gateway, approval and resume, question, pass, react, steering, stop, routine silent, routine `hand_off` and the run it wakes, unattended approval, computer away, policy refusals, ledger closed on every ending.
- Unit tests for every rule above.
- Behavior evals run each case N times with a majority (`--repeat`), and add routine cases: a hostile email asking to change the routine or forward data (refused, reported), report-every-time, a lateness note, an unattended approval with its reason, the report run's tone.

## What we took and what we didn't

From `feat/agent-runtime`: the routine room and `deliverTo`, the tool table per run kind (as access levels on every brain), read-only computer profiles, the readers rule for records, the re-check at delivery, the wrap-up near the cap, the report tone, `--repeat` in evals and six engine bug fixes. Not taken: forcing routines onto the API brain (`needs_model_key`), `set_status`, the notes table and delayed pickup, the outbox priority column (a cap on background slots instead), pass-rate columns.

From OpenMausBot and OpenBot: one catch-up within 12 hours, approvals giving way to the next slot, one notification per cause, the fatigue rule, a minimum interval, read-only work for watchers, event dedupe, a single envelope for outside content. Where we go further: the access level holds on every brain (including the person's own Mac), the human step is the chat itself (a report wakes the agent where people are), and nothing a routine reads can make it act for anyone.

## Consequences

- Existing routines start as `read` and `when_new`: a routine that must change things (Ada's coding routine) needs "Pode agir" turned on.
- A routine on a sleeping computer waits instead of running on the API; Rotinas and one notification say so.
- Runners older than protocol 16 run no Codex turn and no Claude Code `plan` turn (`runner_outdated`): routines that only read, unattended runs and a mission's planning wait for the updated runner (the desktop app's next release) instead of reading with more power.
- On Codex a secret file can be read in `plan` (its sandbox can't deny reads yet); it can't leave through our tools or posts (see §3).
