# 0029. Missions: long work driven by the executor on the agent's computer

- Status: Proposed (prototypes under review: `docs/design/telas/ThreadContexto.html`, `Threads.html`, `Missao.html`, `MissaoChat.html`, `TarefaLonga.html`)
- Date: 2026-10-16
- Planning: D42
- Extends: ADR 0025 (connected computers and the runner), ADR 0015 (tools, approvals, resumable runs), ADR 0008 (agent runs)

## Context

People want to hand an agent work that takes days: "build our mobile app with Claude Code on my Mac". That work is many steps, many decisions, prototypes and PRs, and several iterations with the person. Today it doesn't fit:

- **A run is short.** At most `AGENT_MAX_TOOL_TURNS` (25) model calls; a multi-hour task ends in `too_many_tool_calls`.
- **Tool calls are sequential and blocking.** `run_code` on a connected machine can run an hour (`machineMaxTimeoutSeconds`), but the run waits on it; three Claude Code sessions can't run side by side, and nothing wakes the agent when one finishes.
- **A long command is tied to the socket.** If the connection drops or the machine sleeps, the result is lost.
- **No place for decisions.** `ask_user` asks one question at a time; nothing collects provisional decisions, reviews or what was decided and why.
- **Continuity lives in the executor.** The Claude Code session (`--session-id <thread>`) is on the machine's disk; a new session, another executor or another machine starts from nothing.
- **A new message in a busy thread starts a second, unaware run** in parallel with the first.
- **Anyone who sees a thread can trigger the agent in it**, and on a connected machine that means running commands on someone's computer.

The coding agent on the machine (Claude Code, Codex) is already a strong planner and implementer with its own loop and subagents. Re-doing that intelligence in our model would cost us tokens and do it worse.

## Decision

**The executor on the machine is the brain. Our side is the interface and the guard: it shows, stores, asks for approval and delivers, mostly with code and without a model.** The executor never grants anything: approvals, reviews, access and merges stay with the server.

**A mission is the control layer of long work: what the agent plans, what is running, what waits for you, what was decided and delivered, and the controls (start, pause, stop, approve).** It always lives in a thread; the conversation stays there.

### 1. The ladder

```
conversation in a channel → thread → mission (a thread with a plan) → own channel
                              └─ long task (a thread with work running, no plan)
```

Each step is offered, never forced.

- **Thread from a conversation** ("Criar thread a partir daqui", or a suggestion when a subject runs long in a channel): one click creates the thread with the suggested range as context (a reference; messages stay in the channel), an automatic title, and opens it. Toast "Thread criada com N mensagens · Ajustar · Desfazer". The context block on top of the thread offers "Ajustar trecho" (selection in place on the channel) and "Tirar do canal" (move: messages leave the channel, a stub stays; reversible). The thread stores `context_from` (range in the source channel); the context builder uses that range instead of the fixed "before the root" window, with the thread summary when it is long. A range can only come from a channel everyone in the destination can see.
- **Long task**: one thread is the project. Each round ends in a result to react to (screens, diff, preview); the next round resumes the same executor session. A message sent while a round runs is queued into that round ("incluir nesta rodada" by default, or "depois desta"), never a parallel run.
- **Mission**: a thread with a plan (section 2), its participants (section 9), decisions, reviews and tasks.
- **Own channel**: "Mover para canal novo" when a project grows several subjects.

### 2. The plan is a living checklist kept by the executor

No fixed phases. Fixed phases fight how the executor works (it re-plans, runs items in parallel, finds work that belongs "later"), and a "phase 2 of 5" label goes stale.

- The plan is a list of items (`todo | doing | waiting_you | done | dropped`) in `mission.md`, kept by the executor through `update_plan` (section 6), never edited by hand. Every change posts one line in the thread ("Plano atualizado: + Build de desenvolvimento · − Drawer lateral"), and each version is stored on our side.
- **Reviews instead of gates:** the executor asks for a review when it has something to show (`request_review`: "Pronto para você ver: protótipos de navegação", with artifacts and PR). Approve or ask for changes; the answer resumes the session. A review is a database record like an approval.
- The plan has no authority (it is the executor's intention), so it may live in the file. Decisions and reviews do have authority and live in the database.

### 3. Who starts a mission

The agent **proposes**, the person confirms; nothing becomes a mission silently.

- Signals in a request (needs a computer, several deliverables, days of work, product decisions): a cheap judge (Jev, like the router) scores it; above a threshold the request goes to the executor in plan mode, and the thread gets a plan card: "Plano do Claude Code", title, one sentence, the first items, "No MacBook do Walter · online", **Começar** / **Mudar algo**. Nothing else on the card.
- Explicit: `/mission` in a composer, a DM with the agent, or "Nova missão" on the Threads page. A mission started anywhere gets a home thread created where it started (channel or DM).
- From a thread: "Montar plano nesta thread" (a long task that grew).

### 4. Background tasks on the machine (runner)

The runner protocol gains tasks that outlive a request:

- `task.start { taskId, executor, session, worktree, prompt }`: the runner spawns the executor detached, in the task's own git worktree and branch, writes a local task journal and streams events. `task.status`, `task.cancel`.
- The executor runs with structured output (`claude -p --output-format stream-json --verbose`, `--resume <session>`); the runner reads every event (tool use, files changed, messages, final result with time) and forwards it. This works even if the model never calls our tools.
- Executor hooks (Claude Code `--settings` with hooks calling `agentes-runner hook`) give reliable stop and subtask events.
- On exit the runner always sends `task.done { exitCode, result, seconds }`. The server records it through the outbox and **wakes the conversation** (new run, or a code path that posts the card with no model at all).
- Slots: a per-machine limit of concurrent tasks (default 3); extra tasks queue ("aguardando vaga").
- While tasks run on macOS the runner holds off sleep (`caffeinate -i`) and releases it after.

### 5. Recovery when the machine goes away

- The server already marks a machine offline when its socket closes. Running tasks become `interrupted` after a short grace; the thread gets one message ("MacBook offline desde 14:32"), not one per task.
- On reconnect, `hello` carries the runner's task journal. The server reconciles: every task that should be running and whose process is gone is resumed with `--resume <session>` and a note ("you were interrupted; check `git status` in the worktree and continue"), automatically, or after asking if the mission says so.
- Executors are told to make work-in-progress commits per step and push the task branch periodically, so a crash loses minutes and a dead disk loses little.
- A machine that doesn't come back: the mission waits ("esperando o computador") and can be moved to another machine; the new session starts from the mission files (section 7).

### 6. The `agentes` MCP server: how the executor talks to us

The runner exposes a local stdio MCP server per task (`agentes-runner mcp --task <id>`), passed to the executor (`--mcp-config`, and the equivalent for Codex). Its calls travel over the runner's existing WebSocket. Tools:

- `report(summary, status)`: the agent's message in the thread and the live card.
- `update_plan(items)`: the checklist (section 2).
- `ask_decision(question, options, recommendation, why, impact, blocking)`: a decision card. Blocking: the tool answers "recorded, stop and wait"; the answer resumes the session (`--resume <session> "Decision: …"`) with no model on our side. Non-blocking: the executor proceeds with its recommendation as a **provisional** decision, collected for review.
- `request_review(title, summary, pr, artifacts)`: a review card.
- `request_approval(action)`: merge, deploy, rollback; same approval cards as ADR 0015.
- `upload_artifact(path)`: to the Drive through `pushFile` (ADR 0025), never through a model.
- `get_context(query)`: org decisions, wiki and memory the agent may see (ADR 0017, 0023).

An `--append-system-prompt` (and a `CLAUDE.md`/`AGENTS.md` line) tells the executor to read `.agentes/` first, keep the plan with `update_plan`, report milestones, ask decisions only through `ask_decision`, ask for a review when there is something to show, and never merge directly.

### 7. Mission files in the repository

```
.agentes/
  mission.md     objective, plan (checklist), rules, origin, pending items
  decisions.md   approved decisions with the why            (server writes)
  notes.md       the executor's notes: learnings, next steps (executor writes)
```

- The **database is the source of truth** for anything with authority (decisions, reviews, participants). `decisions.md` and the non-plan parts of `mission.md` are generated from it and written by the runner on every change; local edits are overwritten on the next sync and noted quietly ("Editado no Mac — mantivemos a versão aprovada · Ver diferença").
- The plan section of `mission.md` reflects the last `update_plan`.
- `notes.md` belongs to the executor; the runner sends it back, so we keep a copy if the machine dies.
- "Origem" in `mission.md` is the summary of the thread's context range (section 1).
- Committed in the mission branches by default, so a PR shows which decision produced which change; can be git-ignored per mission.
- Any new session (another executor, another machine) starts by reading these files.

### 8. Our agent's role and context

- The agent (e.g. Dev) routes and relays: decides whether a request goes to the executor or is a short chat reply, answers non-code questions, and speaks in the thread when a person addresses it. Cards from executor tools are rendered by code; they read "via Claude Code no MacBook do Walter".
- When the agent runs, its context gets a **compact mission brief** (plan progress, running tasks, decisions taken and pending, links) instead of the whole thread; the thread summary covers the rest. Artifacts are referenced by id. A mission's context only enters runs in its own thread.
- A finished mission can become a memory summary or a wiki page ("App mobile: decisões e lições").

### 9. Who sees and who acts

**Seeing is inherited; acting is explicit.**

- **Who sees** a thread or mission: whoever can see where it lives (public channel: the org; private channel: its members; DM: its participants). Never wider than its home. Lists and search filter by it (ADR 0017).
- **Who acts** in a mission: its own participant list, independent of the channel. By default only the owner.

| Role | Can |
|---|---|
| Owner | Everything, including the computer it runs on, sharing and handing over |
| Can decide | Decide, approve reviews, ask for work, pause and stop |
| Can comment | Comment and give an opinion on decision cards ("Ana prefere tabs"); triggers nothing |
| Not a participant | Read only, when the home allows it; controls hidden; mentioning the agent in the thread starts nothing ("Pedir para participar") |

- "Compartilhar missão" adds people with a role. "Levar para #canal" changes where it lives (and who sees), not the roles.
- Work on a person's computer only starts from the owner or someone who can decide. A request from anyone else in the thread becomes a suggestion ("Ana sugeriu: dark mode · Aceitar / Recusar").
- Merge, deploy and rollback approvals follow ADR 0015 (agent owner and org admins); the mission owner is notified.
- Handing a mission over does not move the computer: the new owner points it at a machine of theirs, or the previous owner keeps lending theirs, explicitly.
- A plain thread (no plan, no work on a computer) has no owner: whoever created it or an admin can close or archive it; everyone in the channel talks as usual, within the agent's audience (D31).
- Every change of participants, role, owner or computer, and every pause or stop, is audited.

### 10. No mission budget

A mission has no budget. What runs on a connected machine (Claude Code, Codex) uses the owner's own plan and costs us nothing, so it is not recorded as usage (ADR 0025). Our agent's own model calls in the thread (routing, replies) count against **the agent's budget**, as any run (ADR 0026). The UI shows time and progress, not money.

### 11. Threads page, closing and archiving

- A "Threads" screen (sidebar) lists the threads you can see: Todas, Com trabalho, Missões, Fechadas, Arquivadas; search and filters (channel, agent, "precisa de você", "minhas"). "Missões" in the sidebar opens the same screen on that tab. A channel header has "Threads (N)" for that channel.
- **Fechar**: resolved; collapses to one line in the channel; reopens when someone replies. **Arquivar**: hidden from lists and search by default, read only, can be unarchived. Both with undo.
- Closing or archiving with work running asks: stop now, let it finish and close after, or cancel. Closing a mission asks Concluída or Cancelada, with "salvar decisões e lições na wiki".

### 12. Data

- `threads` gains `context_from` (source channel, first and last message), `state` (`open | closed | archived`), `closed_by/at`, `archived_by/at`.
- `missions` (`org_id`, agent, owner, home thread, objective, status `active | paused | done | canceled`, machine, executor, slots, timestamps). One mission per thread.
- `mission_participants` (`org_id`, mission, user, role `decide | comment`, added by, at).
- `mission_plan_versions` (`org_id`, mission, items JSON, by the executor, at).
- `mission_tasks` (`org_id`, mission or thread, title, executor, session id, worktree, branch, status `queued | running | waiting | interrupted | done | failed | canceled`, exit code, seconds, last line).
- `mission_decisions` (`org_id`, mission, question, options, recommendation, why, impact, blocking, status `pending | provisional | taken`, chosen, by whom, when).
- `mission_reviews` (`org_id`, mission, title, summary, PR, artifacts, status `pending | approved | changes_requested`, by whom, when).
- `mission_events` (append-only feed: reports, plan changes, task events, wake-ups) driving the thread, the pinned card and the Threads page in real time.

### 13. UI (prototypes)

- **Thread from context, and a code task end to end** (`ThreadContexto.html`): one-click thread, context block with "Ajustar trecho" / "Tirar do canal", private-channel block, plan card, pinned card with the checklist as a pixel strip in the agent's tones ("4 de 12 itens · 2 rodando · 1 esperando você"), sessions as one human line each ("O que mudou", "Ver saída"), decision and review cards, mission files, recovery after the Mac goes offline.
- **Threads page** (`Threads.html`): tabs, rows, mission cards, close/archive dialogs, details panel, "Threads (N)" in a channel.
- **Mission chat and page** (`MissaoChat.html`, `Missao.html`): still drawn with phases and gates; to be redrawn with the checklist, reviews and participants.
- **Long task** (`TarefaLonga.html`): live work card, rounds with versions and compare, queued mid-round requests, inline question, PR with merge approval.
- No internal terms in the UI (stream, hooks, MCP, runner, exit code, tool names). Slash commands are English (`/mission`, `/stop`, `/summary`, `/computer`).

## Order

1. Background tasks + `task.done` wake-up + journal and reconnect recovery (unlocks long tasks).
2. Mid-round message queueing in a busy thread (fixes the parallel unaware run, useful alone).
3. Threads: one-click thread from a range (`context_from`), close and archive, Threads page.
4. `agentes` MCP server and the executor prompt (report, update_plan, ask_decision, request_review, upload_artifact, request_approval).
5. Missions: tables, plan card, participants and roles, suggestions, decisions, reviews, `.agentes/` sync, mission brief in context.
6. Parallel worktrees and slots, daily digest via routines.

Runner isolation (ADR 0030) interleaves: its level 1 before parallel tasks, short-lived GitHub tokens before reviews and merges matter.

## Out of scope here

- **Runner isolation**: ADR 0030. Until it lands, "merge needs approval" is enforced by instructions only on connected machines, since the executor may hold the owner's own git credentials.
- **Missions on the agent's cloud computer** (ADR 0021): the same model works once that computer runs an executor (D38 path 2: the person signs Claude Code in through the computer's terminal); it needs longer command limits there and counts computer time against the agent's budget.

## Consequences

- Long work costs us almost nothing in model tokens: the executor thinks, our code renders and guards.
- Swapping Claude Code for Codex changes the runner's launch command and MCP config, not the product.
- Progress never depends on the model's cooperation (stream events, hooks, exit), but its quality does (summaries, plan and decisions come through MCP calls).
- No fixed phases means progress is "items done", which the executor can re-plan; plan changes are visible in the thread and versioned.
- Approvals only bind actions that pass through us; on a machine with the owner's credentials that is a policy until runner isolation lands.
- Only explicit participants can make work run on someone's computer.
- The machine's disk keeps the executor's session; mission files and `notes.md` make that loss survivable.
