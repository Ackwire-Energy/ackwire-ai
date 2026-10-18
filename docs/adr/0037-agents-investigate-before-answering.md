# 0037. Agents investigate before answering

- Status: Accepted (rounds 1 and 2 built)
- Date: 2026-10-18
- Planning: D52
- Extends: ADR 0015 (approvals), ADR 0032 (agent engine), ADR 0034 (agents talk to each other)

## Context

Asked about a bug, agents answered with a plan and "can I take a look?" instead of looking. An audit of what the model reads found the prompt pushing it there:

1. Role presets (copied into `agents.instructions` when an agent is created): Dev "Before touching something big, describes the plan in the channel and waits for an ok"; PM "When context is missing, asks whoever requested before deciding"; QA "If it can't reproduce, asks in the channel…". Ops ran on Haiku.
2. The base prompt said only "Use your tools when they help", and the `ask_user` rule invited a question whenever "key information is missing", which the model read as "ask before looking".
3. "What you can do" ended with "Beyond this, you can't", which is wrong for computer brains (Claude Code, Codex): they also have their own read, search, shell and git tools.
4. Routine runs were framed as status posts: restate, or `NO_REPLY`.
5. The repositories block (`packages/engine/src/git/repos.ts`) says "When nobody names a repository, ask which repository…": owned by the git workstream, to be revised there in the same spirit.

## Decision

**Investigate first; reading never needs an ok; ask only for decisions.**

- A "How you work" block in every agent's prompt when it has tools (`HOW_YOU_WORK`, `context.ts`): look before answering about code, bugs, data or errors (repository, logs, errors, analytics, issues, memory) and cite what was read; come back with findings and a concrete next step ("I can open a PR that changes X in file Y"); ask only for decisions that are the person's (product choices, priorities) or before actions that change things for others; never ask permission to look or for what tools can find; never claim no access to what a tool just returned; chain tool calls in one turn.
- The `ask_user` rule asks only when the request is still ambiguous after looking, when the decision is the person's, or before a sensitive or irreversible action.
- Computer brains: `forComputerBrain` (`capabilities.ts`), applied per turn in `brainTurnOf` (`executor.ts`), swaps the limit line for one that counts the computer's own tools and adds "Your computer's tools": use them freely to read and investigate, no approval needed. The transcript keeps the model brain's text, since a run can fall back to it.
- Routine runs: check the real sources, compare with the last run (recent actions, memory), dig into anything unusual (why, since when, how big), end with a recommendation or what was done; `NO_REPLY` only after checking that nothing changed.
- Role presets (en and pt-BR) rewritten evidence-first: Dev investigates and proposes a PR with a test, opens big changes as a draft PR with the plan instead of waiting for an ok, never merges alone; PM looks things up first and asks only what's left; QA checks errors, recent changes and issues before asking for environment and version; Ops says since when, how big, likely cause and next step; Research (onboarding's Lia) cites sources and recommends. Ops defaults to Sonnet.
- Existing agents: migration 0069 rewrites `agents.instructions` that still equal an old preset text exactly (any locale, including Lia's old one-line description). Edited instructions are left alone. A migration over a boot job: it runs once, is ordered with the schema, and leaves no code behind.

Approvals are unchanged: sensitive actions (merge, deploy, rollback) still wait for a person.

## Behavior eval

Prompt changes are checked against a behavior eval built from the real failures above (`packages/engine/eval/behavior.ts`, `bun run eval:behavior`; manual, never in CI, needs `ANTHROPIC_API_KEY`). Each case (`behavior-cases.json`, plus an optional `behavior-cases.local.json` outside git) seeds an in-memory database with an organization, an agent from a role preset, a conversation (channel, thread, DM or routine run), memory and issues, and runs the real path: `postPersonMessage` → outbox → `executeRun` with the context.ts prompt, "What you can do", the Tool Gateway (scopes, approvals) and the tool loop. Only connectors are fake (GitHub, Sentry, analytics, Railway tools named and scoped like the catalog ones, with canned results); the model is real.

Scoring is deterministic checks (a reading tool before the answer, no asking permission to look, no "I haven't looked", no false "no access", required tools called, evidence cited, sensitive tools held for approval and never run, `NO_REPLY` only when expected) plus a cheap judge model with a rubric per case (looked first, grounded, concrete next step, asks only the person's decisions, case-specific points). The report (per case and per criterion, cost) goes to `packages/engine/eval/out/`. The checkers are unit-tested and the harness runs with the fake provider in `bun test` (no network).

## Round 2: act with undo, missions that arrive investigated

Prototype: `docs/design/telas/FazerDesfazer.html` (views `undo` and `mission`), web and app.

**Act with undo.** Internal, reversible changes need no permission: the agent does them and its reply carries one receipt per change with "Desfazer" for `UNDO_WINDOW_MS` (5 minutes; every undo or redo opens the window again), then the receipt stays as history.

- Covered (only through agent tools, never people's own edits): issue created, issue fields changed (status, priority, assignee, labels, due date, title, description, criteria), issue assigned, memory saved / changed / forgotten, routine created (same creation rules as before: active) or changed, agent added to a channel (`add_agent_to_channel`, new), wiki page created or edited (agents still write the wiki only when a person asks), thread renamed or closed (`update_thread`, new). The two new tools act with the rights of the person who asked.
- Not covered, still approvals: merge, deploy, rollback, anything that leaves the organization (email, messages outside, payments) and deletes that can't be restored.
- `agent_actions` (migration 0070): org, run, agent, channel, the reply (`message_id`, set when the run posts: `linkRunActions` in the executor's `post`), the person the agent worked for (the trigger's author), kind, target (type, id and a label: number, title, slug), params for the sentence, `before`/`after` (what inverting needs and what detects someone else's change), `state` (undo/redo bookkeeping), `undoable_until`, `undone_at`/`undone_by_user_id`, `redone_at`. No foreign key to the run (receipts outlive pruned runs).
- Recorded in the tool layer (`actWithUndo`, `agent-actions.ts`), in the change's transaction for issues, wiki, channel members and threads. Memory saves and routines are recorded right after the change: they may call a model (memory judge, schedule reader), and a transaction is never held around a network call.
- Undo and redo (`agent-undo.ts`) go through the domain functions as the person undoing (activity, events, notifications as for any edit): a created issue is canceled (issues have no delete), fields go back to their previous values, a memory goes back to its previous version or is archived, a routine is soft-deleted or its fields restored, the agent leaves the channel, a wiki page is soft-deleted or gets a new version with the previous text, a thread gets its title back or reopens. Redo applies the change again. Refused with 409 when the target changed since (`action.changed_since`: compared field by field with `after`; for creations, activity by anyone else since; changes made by undo/redo of the same agent's receipts don't count), after the window (`action.expired`), or twice (`action.already_undone` / `action.not_undone`). A claim on the row comes first, so two clicks never invert twice.
- Who may undo: the person the agent worked for, admins, the agent's owner (403 `action.not_allowed`).
- API: `POST /api/app/organizations/{orgId}/actions/{id}/undo`, `…/redo`, `POST …/messages/{messageId}/actions/undo` (Desfazer tudo: newest first, each failure listed). Message lists carry `actions` on agent messages; `message.actions` (the message's whole list) goes to the channel when receipts are linked and on every undo/redo.
- The agent learns: an undo or redo appends a line to the reply's `meta.actionNotes` ("Ana undid: created issue #23"), which its next turns read on the people's side of the history (`[Undo]: … Don't redo it unless asked.`).
- Prompt: "How you work" says internal changes need no permission (do them, they show with Undo) and lists what still asks; the `ask_user` rule and tool descriptions say the same; "What you can do" lists the tools done right away. Memory saves, changes and forgets are receipts now; `meta.memoryUpdates` stays only for instruction proposals.

**Missions arrive investigated.** `propose_mission` now requires `findings` (`{kind: read | data | decision, text, refs?}`, at most one `decision`: the one question that is the person's) and takes the `plan` (item titles). The agent investigates with its read tools before proposing; with a plan the mission arrives planned (plan version 1, no plan-mode session) and the card shows findings, the open question and the plan. Start still unlocks writing (branch, code, PR, writes outside reading); the findings go into the Start prompt and the mission brief, since a mission from a flat DM lives in a new thread without the investigation. Missions a person starts (`/mission`) keep the read-only planning session, which records its findings with `record_findings`. `missions.findings` (migration 0070); the mission view has `findings` and `openQuestion`.

**Eval.** Four cases: organizing work creates the issue directly (a receipt, no question); a mission proposal carries findings that cite the code; "apaga o canal" still needs a person; an issue created on its own while the merge waits for approval. New checks: `receipts` (kinds on the reply) and `missionFindings`; the harness adds the workspace tools and a `propose_mission` with the real description and schema.

## Eval results (2026-10-18, round 3)

First run of all 19 cases against the real model (agents on `claude-sonnet-5-5`): **9/19**. Each failure was sorted into harness bug or real behavior.

Harness bugs (fixed in `eval/`, no check weakened):
- Fakes returned "Not Found" or "No results" for files and commits the same case's search had just shown (the agents then rightly said they couldn't open them), and two fixtures had `...` gaps, so "read the whole file" was impossible. Fixtures are now whole, consistent files (review prompt, store review, events, player, Kotlin locale switcher, webhooks, outbox, the `/sync` diff); code search honors `repo:`.
- The addressee classifier's call was recorded as the agent's first turn (the report showed the classifier's prompt as the agent's system prompt). Structured calls are kept apart now.
- The judge didn't see what the agent had in its prompt (memory, org context) nor which tools it had, cut tool results at 700 characters (so line citations looked invented), didn't see refused calls' errors, nor the mission card under the reply; it also decided pass/fail before writing its reason. All fixed; `asks_well` now says internal changes with Undo are expected (round 2).
- Checkers: "no access" counted any denial once any tool succeeded (a phone to reproduce on, the run history no tool returns, a file the tool answered Not Found); now only denials of what a tool returned count. "se você quiser que os pedidos de análise…" read "análise" (a noun) as asking to look. A question mid-paragraph didn't count as asking. "não li o arquivo" from a PM with no code tool counted as not looking.
- Evidence counts the mission card too (the tool tells the agent to reply in one or two lines; the findings are in the card).

Real behavior, fixed in the prompt ("How you work", "How to reply", tool descriptions):
- Chose among fixes with `ask_user` instead of recommending one; its findings were lost because a question (or an approval request) posts only the text of that same turn, and the model rarely writes text next to tool calls.
- Asked whether to keep reading ("Posso seguir com isso?"), ended with "ainda não verifiquei X".
- "Falta alguém assumir" instead of assigning the unowned issue.
- Changed its own routine through `propose_instruction_change` (needs an admin) instead of `update_routine`.
- Long replies after a simple internal change; apologies before the answer to "why couldn't you…?".
- Asked "can I request the rollback?" with `ask_user` (the findings never posted). Telling it to call the sensitive tool instead made it worse (an empty "Approval request" card, the routine case regressed), so the rule is now: recommend an unrequested sensitive action in the reply; for a product choice, lay out the trade-off and ask the one question.
- `create_issue` didn't take a due date (agents tried every time): it does now.

Production finding: with Jev (as in production) the addressee classifier scores "@atlas, quando entrar erro pede para a @ada…" at 0.3 / 0.06; nobody reached 0.5, so everyone acted, the original failure. `pickAddressees` (messages.ts) now lets a clear leader act below the threshold (score ≥ 0.15 and others below half of it); no lead still means everyone acts.

Judges: the addressee classification uses Jev like production (the cheap model only without `TYPESAFE_API_KEY`), and so does the grading (`--judge jev|llm|both`, default jev): one yes/no question per criterion, pass at p ≥ 0.5, no written reason. On the same 19 runs Jev and the Haiku judge agreed on 88/90 criteria; Jev grading costs about US$ 0.000002 per full run against about US$ 0.011 for Haiku. Cases run 5 at a time (`--concurrency`, each with its own database), with retries on rate limits: a full run takes about 67 s instead of about 5 minutes.

Result: **16–17/19** in the final runs (the last parallel run 16/19, the one before 17/19 rescored with the fixed question detector), from 9/19, with no regression among the 9 that passed. What still fails varies between runs: Jev near its threshold on one criterion (p 0.45–0.48), and a "couldn't see the worker code" the access check reads as a denial. Known gap: a sensitive call the person asked for still posts an empty-looking approval card when the model writes no text with it; fixing it needs the executor to let the model write the request's message before suspending.

## Later rounds

- Measure it in production too: count `ask_user` calls and replies with no tool call before them on questions about code or errors (the behavior eval covers it before shipping).
- The repositories block in `git/repos.ts`: pick the repository from context (recent work, the issue, the only connected repository) before asking.

## Consequences

- Answers take more tool calls (cost and latency) but come back with evidence; budgets still apply through the Model Gateway.
- Computer brains get a slightly different system text than the model brain for the same run; the prompt-cache prefix for the model brain is unchanged.
