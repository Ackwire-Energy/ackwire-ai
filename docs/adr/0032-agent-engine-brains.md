# 0032. One agent engine, swappable brains (model, Claude Code, Codex)

- Status: Accepted (built; computer brains are chosen per agent; missions run only on the engine, no flag). Superseded in part by ADR 0059 (§5: the plan warning shows when a plan would answer other people, not when it is chosen). Superseded in part by ADR 0077 (2026-10-28): §2's git on cloud computers (connected computers use the git proxy through the runner). Amended 2026-10-30: §3 (a decision that comes while the turn that asked still runs, and a turn that ends on a decision without a word; ADR 0037, round 3); 2026-10-31: §5 (Quem pensa lists what pays, and says the computer only where it changes something).
- Date: 2026-10-17
- Extends: ADR 0008 (agent runs), ADR 0015 (Tool Gateway and approvals), ADR 0025 (connected computers and the runner), ADR 0029 (missions), ADR 0030 (runner isolation)

## Context

Agents think through the Model Gateway with an API key. People who pay for Claude Code or Codex want their agents to think with that instead, on their own computer, and missions already drive Claude Code and Codex through the runner (ADR 0029).

Today the pieces don't share a spine:

- `executor.ts` does everything for a model run: builds the context, owns the run states, calls the model, executes tools through the Tool Gateway, keeps the transcript, streams deltas, pauses on approvals and records usage.
- Missions have their own path: runner tasks, an `agentes` MCP server with mission-only tools, resumes by session id, an inbox, their own approval and decision plumbing.

Adding "an agent whose brain is Claude Code" as a third path would copy the run lifecycle, the tool layer and the approval flow again. Every rule (a new tool, a scope, an audit entry, a budget check, a streaming tweak) would have to land in three places, and they would drift.

## Decision

**One engine runs every agent turn. What changes is only the brain that thinks. Everything else — context, run states, tools, approvals, transcript, streaming, usage, events — lives in the engine and is the same for every brain. Missions run on the same engine.**

### 1. The brain interface

A brain receives a turn and returns a stream of neutral events; it never touches the database, tools or approvals directly.

```ts
interface Brain {
  kind: "model" | "claude_code" | "codex";
  /** One turn: context in, events out. Resumable from a transcript or a session. */
  run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent>;
}
type BrainEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }   // engine executes it
  | { type: "usage"; input: number; output: number; source: "api" | "plan" }
  | { type: "limit"; resetsAt?: string }                              // plan limit hit
  | { type: "done"; text: string }
  | { type: "error"; code: string; message: string };
```

- **Model brain**: today's gateway loop, unchanged in behaviour (budget check before the call, usage with cost).
- **Claude Code / Codex brains**: a session on the agent's computer through the runner (`--resume <session>`), stream-json parsed into `BrainEvent`s; usage recorded with source `plan` and cost zero.

### 2. Tools exist in one place

The Tool Gateway is the only source of tools, scopes, levels (consult / alter / approval / off, ADR 0016 addendum), approvals and audit.

- Model brain: the engine passes the gateway's tool list to the model and executes calls directly, as today.
- Computer brains: the runner's `agentes` MCP server becomes a **bridge** with no tools of its own. `tools/list` asks the engine for the tools this run may use; `tools/call` is executed by the engine through the same Tool Gateway with the run's identity. The mission tools (`update_plan`, `ask_decision`, `request_review`, `complete_mission`…) become ordinary gateway tools available when the run is in a mission thread.
- Connectors (GitHub, Linear, Sentry, Drive, org MCPs) are reached the same way: the executor never receives a connector token (ADR 0007). Plain `git` on a connected computer uses the runner's credential helper with a short-lived, branch-scoped token (ADR 0030); on cloud computers, the git proxy (ADR 0024).
- Claude Code's permission prompts (`--permission-prompt-tool`) and command policy (deny list, low-risk auto-approval, mission rules) are engine features shared by every computer brain, not mission-only code.

### 3. Approvals and pauses work the same

A gated tool call pauses the run (`waiting_approval` / `waiting_input`), whatever the brain. On the decision the engine resumes:

- model brain: calls the model again with the transcript (today);
- computer brains: resumes the session with the tool result ("approved: …" / "refused: …").

Blocking decisions and reviews in missions use the same pause/resume.

*Amended 2026-10-30:* the run goes on with the result in hand, whenever the decision comes.

- A computer brain's gated call is marked `inTurn` on its pending call while the turn that made it still runs. A decision's job that finds such a call while that turn's job still holds the run (an `agent_run.execute` job claimed, its lease live) leaves the run alone; the turn's end (`suspendedByBridge`) clears the mark and, when everything it waited on is already decided, queues the resume itself. The session never takes two turns at once. Any job that finds its run `running` under another live job returns too (two resumes of one pause, two decisions at once).
- On the resume the run keeps what was decided and what came back (`transcript.decided`). When the next final answer has no word from the agent (no text, no narration since its last message) and isn't a reaction or a mission report, the run gets one more turn that says to finish the task with what the call returned, then what was decided and what came back (`decisionNudge`, once per run, `nudged: "decision"` step). Each result is cut in its middle, so one inside an outside envelope (`<external_data>`) stays closed and nothing the run is told reads as outside data. Background runs keep speaking only through `hand_off`.

### 4. Context is built once

`context.ts` builds the run context for every brain. The model brain receives it as system/messages; computer brains receive it at session start (`--append-system-prompt` / first message) and fetch the rest through the same retrieval tools the gateway already exposes (search context, summaries, wiki, memory). The mission brief (ADR 0029) is part of this builder.

### 5. Choosing the brain

- Per agent: **Modelo (API)** (default), **Claude Code no <computador>**, **Codex no <computador>**, each with a model (`--model opus|sonnet|…`, `-m <model>`; `--fallback-model` for Claude Code). Only what the computer has is offered (runner detection, protocol 7). A mission can override the agent's brain and model.
- The agent keeps its audience. Choosing a plan brain shows a clear warning that the subscription is personal and that answering other people with it may go against the provider's terms; the person confirms and owns the risk. We don't block it.
- **Fallback, by what exists**: when the computer is offline, the executor isn't logged in, or the plan limit is hit:
  - if a model credential exists (the platform key on the Cloud, or an org/default key), the turn runs on the model brain and the reply carries a quiet note ("respondi pela API: o Claude Code no mac está offline"); that turn counts against the agent's budget;
  - if no model credential exists (a self-hosted install running only on plans), the agent says it is unavailable ("o Claude Code no mac está offline; respondo quando ele voltar") and the message waits in the run queue until the computer is back.
- **Speed**: computer brains keep one process per active thread (`--input-format stream-json`), closed after ~10 idle minutes and resumed with `--resume`.

*Amended 2026-10-31:* people pick what they pay for, not the program that runs it. A card read "Claude Code" with "DeepSeek V4.1 Flash" chosen under it, which made no sense to someone paying for OpenCode Go. "Quem pensa" now lists "Chave de API" (paid per use, on the agent's budget), "Claude" and "ChatGPT" (their sign-in opens in the card when nothing of theirs is there), then each coding plan with an account there that is the viewer's or that the agent thinks with ("OpenCode Go"). The chosen card opens into labeled fields: **Modelo**, only that plan's models (another card starts on its plan's default, Automático stays Automático, and coming back restores what was saved), with a note on how to give what a chosen model needs from its plan's account (OpenCode's Global region) and a link to the plan's site; then **Conta**, only that plan's accounts (the computer's own sign-in only on Claude and ChatGPT), where a refused key asks for a new one. Another plan on the same program is another account, which only the agent's owner picks (ADR 0059 §1–3): to anyone else that card is locked ("Só João troca"), while another program and the API key stay open to them. Claude Code and Codex are named only where the program is what is missing ("O Codex não está instalado no MacBook."), and the computer only where it changes something: a move, offline, or no computer having it. Every surface says what thinks in one sentence, the model by the plan that pays ("DeepSeek V4.1 Flash pelo OpenCode Go", `thinksWith` in `packages/client/src/lib/brain.ts`): the toasts, the agent's "Pensa com" cell (the model and its effort over the plan, or its account among two of that plan), the DM header, the profile card, "Usar em outros agentes" and the phone's "Pensa com", whose account list is the plan choice. Moving from the API onto a plan says that the agent now answers only its owner (ADR 0059 §5), in the same sentence as a move to another computer, and to anyone but that owner names them ("…e só atende João"), as the plan cards say whose plan it is ("Usa o plano do Claude de João"). On the phone an account of another plan says what thinks now, since the model changes with it. "Conectar outro plano" opens Connect an AI for the agent.

### 5a. The rest of the system also needs a model

Besides an agent's turn, several parts call a model in the background: the router (who answers), thread summaries, reflection and memory consolidation, the judge (low-risk command approval, connector tool classification, mention checks), thread titles, date parsing. On the Cloud they run on our key (and the fast judge) and are invisible.

For installs where only plans exist:

- **Default: a small model key for system tasks.** The self-hosted setup asks for one cheap model credential used only by these tasks (cents a month); plans do the agents' heavy work.
- **Graceful degradation when there is no key at all.** An explicit @mention always answers (no router); without summaries the context uses recent messages only; without the judge, "Só o que é arriscado" behaves as "Pergunta sempre" and connector tools default to "Pede aprovação"; titles fall back to the first message. Everything works, with less automation, and the UI says which automatic features are off.
- **Optional, later: system tasks on the executor** (short runs on Claude Code/Codex). No key needed, but slow and it spends plan limits, so it is opt-in.

### Editions

The engine is the same in both editions; only defaults differ: the Cloud encourages the model brain (usage through our gateway, budgets, no dependency on a person's computer, no plan-sharing risk) and offers computer brains as an advanced option with the warning; a self-hosted install with Claude Code or Codex on its computers can suggest them first. This is an edition default (ADR 0002 modules), not separate code.

### 6. Missions run on the engine

A mission's main session is simply the agent's run in the mission thread with the mission's brain; item work is runs/tasks of the same engine in their own branches or subfolders. The mission-specific runner path (its own MCP tool set, resume plumbing, inbox delivery as a special case) is replaced by engine features. Missions keep their data and UI (plan, decisions, reviews, deliveries, `.agentes/`); only the execution spine is shared.

## Order

1. Extract the engine and the `Brain` interface from `executor.ts`; the model brain is today's behaviour (existing tests guard it).
2. Runner MCP bridge → Tool Gateway (tool list and calls per run identity); mission tools become gateway tools.
3. Claude Code brain (session, streaming, permission prompts, command policy), the per-agent brain + model setting, the warning, the fallback to the model brain.
4. Missions move onto the engine; delete the mission-only execution path.
5. Persistent process per thread; Codex brain.

## Consequences

- One place for tools, approvals, audit, streaming and usage: a new tool or rule works for every brain and for missions at once.
- Missions lose their parallel execution path; the code gets smaller.
- People can run their agents on their own plans, at their own risk, with the model brain as a safety net.
- The engine extraction is a large refactor of `executor.ts`; it lands behind the existing tests with no behaviour change before any new brain is added.

## As built (blocks 1–6, 2026-10-17)

### Engine and brains (block 1)

- `packages/engine/src/brains/types.ts` is the one copy of the contract (`Brain`, `BrainTurn`, `BrainIO`, `BrainEvent`, `ToolResult`, `BrainTool`, `BrainSession`). The engine stays in `executor.ts` (`executeRun`, `EngineDeps`; `RunExecutorDeps` is an alias). Brains: `ModelBrain` (`brains/model.ts`), `createClaudeCodeBrain` (`brains/claude-code.ts`), `CodexBrain` (`brains/codex.ts`), registered by kind in `EngineDeps.brains` (`BrainFactory(agent, run, { mcpToken })`) in `apps/server/src/engine.ts`.
- One `run()` is one turn. The model brain yields `tool_call` without `executed`; the engine runs it through the Tool Gateway, appends the result and calls `run()` again (loop, limits, steering, pauses and cancel stay in the engine). The model brain reads the exact transcript blocks through its constructor (cache breakpoints, opaque thinking blocks); other brains get `BrainTurn.system` / `.messages` as text.
- **Computer brains end their turn with their tools.** Their `tool_call`s arrive `executed` (the bridge already ran and recorded them): they are shown, not re-run, and the turn ends at `done` (never re-sent). Executed calls are left out of the transcript, so it stays valid if the model brain takes over in a later turn. A turn that only ran tools and said nothing closes with "Done." (unless a bridged `react` made silence the answer).
- **Bridged side effects.** A bridged call's `data` (`reacted`, `artifact`, `missionLink`, `memoryUpdate`) goes through the same `absorbToolData` as the loop's calls: the bridge keeps it on the run (`transcript.bridgeEffects`, `memory.updated` published at once) and the engine takes it when it ends the turn (`takeBridgeEffects`), so the reply carries the cards and a bridged `react` closes the turn silently.
- **One reply placement.** `replyThreadOf` / `runWhere` (`run-tools.ts`) decide where a run's replies, cards and events go (flat for a top-level DM, forum or routine trigger; else the thread), for the engine and the bridge alike.
- One implementation of tool access from outside the loop (`run-tools.ts`): `bridgeToolsFor` / `invokeToolForRun` (the runner bridge); the contract's `toolsForRun` / `executeToolForRun(deps, RunIdentity, call)` (executor.ts) and `BrainIO.executeTool` call them. The live tool chip is `invokeWithChip` for both. A gated call suspends the run like the loop (`suspendRunForTool`): it locks the run row and decides before posting anything — `running` suspends; already waiting on a call bridged in the same turn (two gated calls at once) joins the pending calls; any other state posts nothing, cancels the gateway's request and returns an error (`bridge.run_not_running`). After a computer-brain turn the engine reads the run's state: a bridged pause left it `waiting_*`, so the engine keeps the pending calls the bridge recorded, posts what the brain said and stops there — also when the brain then failed (no fallback, no failure). On the decision the engine resumes the run and the brain's session reads the result as text ("What a person decided on your waiting call: …"), since its `tool_use` lives in the session.
- Plan usage: each `usage { source: "plan" }` of a computer brain is recorded by `recordPlanUsage` (tokens on the run, agent and org, cost zero, `billed_to = plan`).

### Who thinks (blocks 3a + engine)

- Stored choice (migration 0061): `agents.brain` (`model` | `claude_code` | `codex`), `agents.brain_model`, `agents.brain_fallback` (default on); `missions.brain` / `missions.brain_model` override for a mission. APIs `GET/PUT …/agents/{id}/brain` and `…/missions/{id}/brain` (`brain-settings.ts`; `acceptPlanTerms` required to switch to a plan brain); web "Quem pensa" in the agent's settings and the executor's model in the mission's settings.
- `resolveBrain` (`brains/select.ts`) per run: the mission's brain and session when the run is its main session (`missionTurnFor`) → the agent's stored brain (`brainFor`) → availability on the agent's computer (`computerBrainUnavailable`: no computer, offline, commands off, runner below protocol 8, CLI missing or not logged in per `hello.executors`, Codex too old, a plan limit seen on this process until its reset).
- Session (2026-10-19): stored on the run (`agent_runs.brain_session_id`, so a pause resumes the same one). A new run takes the conversation's (thread, or the channel of a flat DM) last session only while it is recent (`SESSION_IDLE_MS`, 1 h) and its last turn read less than `SESSION_MAX_INPUT_TOKENS` (150k); else a fresh one, `brainSessionId(agentId, conversation:runId, kind)`, which gets the recent messages as its first prompt. A routine run always starts fresh. Before, one session per conversation was resumed forever: a half-hourly routine re-read up to 734k tokens per check. `resume` is a hint (plan usage exists for a run of that session); missions pass their main session (`main_session_id`, `repo_dir`). Model (`brainModelFor`): the mission's, else `agents.brain_model` only when the agent's brain is this same kind, else the brain's default (`sonnet` for Claude Code; Codex's own).
- Choosing a computer brain (`brainOptions`) requires the runner's `BRAIN_PROTOCOL` (8), the same check as at run time (`runner_old` below it); a mission's executor choice keeps its own check (`machineExecutors`).
- **No redo after tools ran.** A computer brain that fails mid-turn after tools already ran (bridge `tool_result` steps since the turn began, or calls it reported executed) is neither handed to the model brain nor retried: their side effects happened and they aren't in the transcript, so redoing the turn would run them twice. The engine posts what the brain wrote with `meta.brainInterrupted { brain, code, message, text, tools }` (the app adds the note in the person's language) and ends the run `done`.
- **Fallback, by what exists** (§5): the pre-check, a `limit`, or a brain error that is retryable or one of the unavailability codes (with no tool run in that turn) → if `brain_fallback` and the model brain has a credential (`ModelGateway.hasModelCredential`: catalog, provider and a key that resolves) the turn runs on the model brain and its replies carry `meta.brainFallback { from, code, message }` (the quiet note; it counts against the budget). Otherwise the agent posts once "… I'll answer when it's back" (`bodyCode: brain_unavailable`), the run waits in `waiting_input` with `transcript.waitingForBrain` (with a `waitId`) and `agent_runs.waiting_machine_id` (migration 0062, partial index; cleared by any transition out of `waiting_input`), and it is queued again when the computer comes back (`resumeRunsWaitingForMachine` from the hub's `online` hook: one job per wait, dedupe key `…:brain_back:{waitId}`) or at the plan limit's reset.
- **Busy computer** (added 2026-10-27). A turn the runner refuses for room (`no_slot`, ADR 0025 §5, admission) or at its request ceiling (an older runner's `busy`) is the brain error `busy`, for Claude Code and Codex. With a model credential the fallback stays as for any computer that can't answer. Without one the run waits as for an offline computer (`waiting_input`, `waitingForBrain` with code `busy`, `waiting_machine_id`, the same one note per place), but an online computer sends no "back" signal, so a job asks again every 15 s (`COMPUTER_BUSY_RETRY_MS`, dedupe key `…:room:{waitId}`). Each look is a job of its own, so the run's job keeps its tries; it says nothing in the conversation until a turn starts (no "thinking" every 15 s), and the run's trail gets one step per wait. The note says "My computer is busy with other tasks right now. I'll answer as soon as it's free." (`bodyCode: brain_unavailable` with `brainUnavailable.code: busy`: the apps word it `chat.body.brain_busy` and show no waiting card, the computer isn't away). A routine's run waits quietly, without the "waiting for the computer" notification. 30 minutes after the first refusal (`COMPUTER_BUSY_WAIT_MS`, `transcript.roomWaitSince`, ended by any turn the computer takes or any other wait) the run fails with `computer_busy` (`run.computer_busy`, worded in both languages in the chat, Atividade and Rotinas): a turn usually ends within minutes, so a computer full that long is stuck or too small for its agents, and the person can ask again. Before, `busy` retried on the job's backoff and failed `gave_up` after about 2.5 minutes.

### The runner MCP bridge (block 2)

- Identity: `run_tool_tokens` (migration 0060), SHA-256 of `agr_…` tokens bound to org, agent, machine and a run or a mission task (`issueRunToolToken` / `verifyRunToolToken` / `revokeRunToolTokens`). The engine issues one per computer-brain turn and passes it in `brain.turn.mcp.token`; tokens are revoked when the run stops or waits. Verification checks the hash, the machine holding the socket, expiry, and that the run is `running` (a waiting or ended run is refused) or the task has not ended. Mission tasks get one at `startMachineTask`.
- Protocol 8: `mcp.call` carries `token`; `mcp.list` → `mcp.tools` answers `tools/list` with the run's Tool Gateway list (`toBrainSchema` inlines `$ref` and flattens top-level `oneOf`/`anyOf`/`allOf`). Without a token (runners up to protocol 7) the legacy mission path stays.
- `run-tools.ts`: `bridgeToolsFor` (runs and mission tasks), `invokeToolForRun` (error codes) and `suspendRunForTool` (approval / question / secret cards, or a mission tool's own wait; the pending call is marked `bridged`).
- Mission tools are gateway tools: a task's (`createMissionBridgeToolSource`, its own gateway, `permission_prompt` included); a computer-brain run in its mission thread gets the main session's mission tools (`createMissionToolSource`) plus `get_context`, `upload_artifact` and `start_task` (`createMissionRunToolSource`, listed before the sandbox tools so they win the `start_task` name for bridge calls).
- `permission_prompt` works for runs: in the agent's open mission thread it is the mission's command card flow keyed by the run (no task; `PromptAsker`); elsewhere `runPermissionPrompt` (deny list refused, plain reads allowed, and what code allows when the agent has the sandbox scope; the rest denied with what to do instead: nothing waits for a person outside a mission).
- **A permission check reads as its command** (added 2026-10-30). Each command Claude Code or Codex asks about is a `permission_prompt` step, and the bridged chip carried no label for bridge calls, so a long run showed a column of the same "Consultou o permission" line. Its label (`toolDetail`, on the bridged chip and on the recorded step) is the command: Claude Code's own one-line `description` when it gave one, else, built from the already masked line (`redactCredentials`: also an address's user and password and the value after a secret-named option such as `--password`), the first program and its main argument: the words before its first option, else its first path or web address, never another word after an option (it could be that option's value), a web address as its site and path. The chip and the step also carry the whole command as one line, masked (`command`, at most 1000 chars), which the line opens on. A refused command ends its chip `failed` with the policy's reason (`why`, only from a `deny` answer: an error's text could hold anything) and its code (`refusal`: every `deny` the server answers carries one, `person`, `expired`, `never`, `secret`, `plan`, `tooMany`, `off`, `team`, `unknown` or one per `forbiddenReason`, `forbiddenCode`), which the apps say in the person's words (`chat.work.refusal.<code>`, `toolWhy`; the reason's first sentence only for an answer with no code). One waiting on a person ends it `held` with its request (`requestId`). The runner asking again about it (`request_id`) gets no chip and no step on the task's card (`promptPoll`) and is left out of the reply's tool count (`meta.work.steps`); once the person answers, an end with that `requestId` and no `toolUseId` settles the line that waited (refused when they said no), live and in a saved trail, and a run whose last call waits on a person never reads as quiet (`isQuiet`). The task's card reads the checks' answers too: a step refused or still waiting carries `outcome` (`refused`, `waiting`) and reads "Recusado: …" or the stopped verb, never "Rodou". The apps say "Rodou: …" / "Ran: …" and "Recusado: …" / "Refused: …" with the reason under the line, and fold the same line in a row, the task's card too ("×3" with the last time); a failed or waiting call stays a line of its own, live and saved. Our own tools whose first word read like an app (`hand_off`, `git_clone`, `open_pull_request`, `record_findings`, `complete_mission`, `suggest_forum_topic`, `request_permission`, `request_folder_access`, `request_secret`, `use_tool`, `follow_up`, `cancel_follow_up`, `desktop_*`, and `pg_<slug>_*` when no connection label comes with the event) have their own words.

### Claude Code and persistent processes (blocks 3b + 5)

- **Protocol 8, one bump** (`MACHINE_PROTOCOL_VERSION = 8`, `BRIDGE_PROTOCOL = BRAIN_PROTOCOL = 8`, runner 0.8.0): `brain.turn { runId, kind, session: {id, resume}, cwd, model?, system, prompt, mcp: {token}, keepAlive?, personalMcp?, permissions? }`; the runner streams `brain.event { runId, event }`, then `brain.done`, and the result repeats the final event. The hub publishes the frames on `brainTopic(runId)` for whichever replica runs the turn.
- **Runner** (`apps/server/runner/brain.ts`): `claude -p` with stream-json in and out, `--resume` or `--session-id`, `--model` (+ `--fallback-model sonnet` under opus), `--append-system-prompt-file`, our MCP bridge (`--strict-mcp-config` unless `personalMcp`), and the command policy (`--settings`, `--permission-prompt-tool`, deny list). Missions pass their policy (plan before Start, work after; branch prefix; allowed commands). Only our bridge's tools become `tool_call` events (`executed`); usage is `plan`; a rejected rate limit is `limit{resetsAt}` then `error plan_limit`; login failures `not_logged_in`.
- **One process per (agent, session)**, stdin open, closed after 10 idle minutes, at most 3 (least recently used idle one closed; all busy → one-shot). Its MCP server is bound to the process; the bridge relays its calls for the run thinking now, with that run's server token (`McpTaskInfo.runId` / `serverToken`).
- `hello.executors.claude` carries `loggedIn`, `authMethod`, `plan` (`claude auth status --json`).

### Codex (block 6)

- Same `brain.turn` op: the runner's dispatch sends `kind: "codex"` to `handleCodexBrainTurn` (`apps/server/runner/brain-codex.ts`): `codex exec --json` per turn (`resume <thread_id>` next turns; our session → Codex thread in `<runner home>/brain/codex-threads.json`), JSONL → `BrainEvent`, our MCP bridge as `mcp_servers.agenteschat_agentes` (`agentes-runner mcp --run <runId>`, token in the env), relayed for the run while the turn lasts. Not on Windows yet. `CODEX_MIN_VERSION` (0.163.0) is kept in the runner and the engine.
- Engine side: `CodexBrain` over `hubBrainLink` (`brain.turn` through the hub, events from `brainTopic`); availability errors are retryable (fallback). Default model: the catalog's recommended OpenAI model (`gpt-6.1-sol`).

### Missions on the engine (block 4; the only path)

- **Brain.** `missions.brain` when set, else the executor (`claude` → `claude_code`, `codex` → `codex`, `agent` → `model`); model from `missions.brain_model`. Computer brains get `BrainSession { id: main_session_id, resume, machineId, cwd: repo_dir }`; `resume` once an earlier engine turn started that session (`engine_session` event). The brief (`missionBrief`) tells every brain it does the work itself in the thread.
- **Main session = runs** (`createMissionEngine`, `tellMainSession`): every wake-up of the main session (proposal, Start, a person's word, accepted suggestions, decisions, reviews, an item's end, the inbox) posts the notice in the home thread and starts a run in the same transaction (one run per agent and notice; or joins the run working there). One plan prompt and one start prompt (`planPrompt`, `START_PROMPT`), the same for every brain. A blocking `ask_decision` or a `request_review` returns `data.pause` with the decision's or review's id: the run waits (`waiting_input`, pending call with `waitId`), and the answer resumes it (`resumeRunWithResult`) with the text as the tool result; with nothing waiting, the answer starts a turn. Merge, deploy and rollback are the main session's `request_approval`, an ordinary ADR 0015 approval of its run.
- **Item work** stays machine tasks (own session, branch or subfolder; runner `task.start` with the mission, always in work mode), started by the run with `start_task`, with the restricted mission gateway (`createMissionBridgeToolSource`: `report`, `update_plan`, `ask_decision`, `request_review`, `upload_artifact`, `get_context`, `permission_prompt`; `request_approval` is not listed, so the gateway refuses it as unknown). An item's end is a notice for the main session ("waiting for a decision/review" when it stopped on one); the main session's own tasks (the sandbox `start_task`) end like any of its wake-ups.
- **Gates**: paused, closed or no computer → the text waits in `missions.inbox` (`deliverMissionInbox` sends the main session's part as one notice and resumes item sessions as tasks); the stuck-loop guard counts wake-ups for every brain; stop, close and a new executor before Start cancel the agent's runs in the thread (tokens revoked).
- **Deleted (2026-10-17): the flag and the old path.** `MISSIONS_ON_ENGINE` is gone; so are executor tasks for the main session (plan and work modes of `task.start` for it, `task.start.mission.mode`), the agent-mode-only wake and inbox code, `send_to_mission` and the brief's "route and relay" branch, the duplicated plan/start prompts, the task-bound mission approvals (`createMissionApproval`, `onMissionApprovalDecided`, job `mission.approval_decided`) and the open-missions migration (`mission.engine_migrate`). Missions open before this change are not migrated and may stop or need a new message; approvals left with `run_id` null are not drained. Unused columns (`machine_tasks.waiting_for` for main sessions, `approvals.mission_task_id`) stay; committed migrations don't change.

### Known limits

- ~~A decision that arrives while a computer brain is still finishing the turn that paused can start the resume while the first execution is still closing the turn.~~ Fixed 2026-10-30 (§3).
- `personalMcp` has no setting yet (always off); the quiet fallback note and the "unavailable" note are in `meta` (the web shows the body; a dedicated chip is to do).
