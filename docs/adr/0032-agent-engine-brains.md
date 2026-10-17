# 0032. One agent engine, swappable brains (model, Claude Code, Codex)

- Status: Accepted (to build)
- Date: 2026-10-17
- Planning: D38 (revision of 2026-10-17)
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

### 4. Context is built once

`context.ts` builds the run context for every brain. The model brain receives it as system/messages; computer brains receive it at session start (`--append-system-prompt` / first message) and fetch the rest through the same retrieval tools the gateway already exposes (search context, summaries, wiki, memory). The mission brief (ADR 0029) is part of this builder.

### 5. Choosing the brain

- Per agent: **Modelo (API)** (default), **Claude Code no <computador>**, **Codex no <computador>**, each with a model (`--model opus|sonnet|…`, `-m <model>`; `--fallback-model` for Claude Code). Only what the computer has is offered (runner detection, protocol 7). A mission can override the agent's brain and model.
- The agent keeps its audience (D31). Choosing a plan brain shows a clear warning that the subscription is personal and that answering other people with it may go against the provider's terms; the person confirms and owns the risk. We don't block it.
- **Fallback, by what exists**: when the computer is offline, the executor isn't logged in, or the plan limit is hit:
  - if a model credential exists (the platform key on the Cloud, or an org/default key), the turn runs on the model brain and the reply carries a quiet note ("respondi pela API: o Claude Code no mac está offline"); that turn counts against the agent's budget;
  - if no model credential exists (a self-hosted install running only on plans), the agent says it is unavailable ("o Claude Code no mac está offline; respondo quando ele voltar") and the message waits in the run queue until the computer is back.
- **Speed**: computer brains keep one process per active thread (`--input-format stream-json`), closed after ~10 idle minutes and resumed with `--resume`.

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

## Block 1 as built (2026-10-17)

- `packages/engine/src/brains/types.ts` holds the shared contract (`Brain`, `BrainTurn`, `BrainIO`, `BrainEvent`, `ToolResult`, `BrainTool`, `BrainSession`). `brains/model.ts` is `ModelBrain`; `brains/select.ts` is `brainFor` (always `"model"` for now).
- The engine stays in `executor.ts` (no rename: `executeRun`, the job and every import keep working). Its deps type is `EngineDeps` (`RunExecutorDeps` is an alias) and takes optional `brains` factories by kind, where block 3 registers the computer brains.
- One `run()` is one turn. The model brain yields `tool_call` without `executed`; the engine executes it through the Tool Gateway, appends the result and calls `run()` again, so the loop, limits, steering, pauses and cancel stay in the engine. A `tool_call` with `executed` (bridge) is only recorded.
- The model brain needs the exact transcript blocks (cache breakpoints, opaque thinking blocks, tool results), which `BrainTurn`'s text fields can't carry: it reads the transcript through its constructor and leaves the full gateway result in `ModelBrain.last` for the transcript and the `model_call` step. Other brains get `BrainTurn.system` / `.messages` as text (computed lazily; tool calls and results inline).
- Model failures still throw (same classification and retries). A brain's `error` event becomes `BrainFailure` (`retryable` retries the job, else the run fails with `code`); `limit` fails with `plan_limit` until the fallback lands (block 3).
- `toolsForRun(deps, RunIdentity)` and `executeToolForRun(deps, RunIdentity, call)` share `listRunTools` / `invokeRunTool` with the loop. `executeToolForRun` returns `pause` for gated calls but does not post the card or move the run to `waiting_*`: that suspend lives in the engine loop and block 2 must route bridge pauses through it.

## Block 2 as built (2026-10-17): the runner MCP bridge

- Identity: `run_tool_tokens` (migration 0059) holds SHA-256 of `agr_…` tokens bound to org, agent, machine and a run (computer-brain turn) or a mission task. `issueRunToolToken` / `verifyRunToolToken` / `revokeRunToolTokens` in `run-tool-tokens.ts`. Verification checks the hash, the machine holding the socket, expiry, and that the run is `running` (refusing `waiting_*` and ended runs) or the task has not ended. Mission tasks get one at `startMachineTask` (`TaskStart.mission.mcpToken`).
- Protocol 8 (`BRIDGE_PROTOCOL`): `mcp.call` carries `token`; `mcp.list` → `mcp.tools` answers `tools/list`. Without a token (runners up to protocol 7) the server keeps the legacy path: the task named by the frame, its own checks.
- `run-tools.ts`: `toolsForRun` / `executeToolForRun` with the contract signatures on the Tool Gateway, plus `invokeToolForRun` (error codes for the bridge) and `suspendRunForTool` (a gated call through the bridge posts the approval / question / secret card, joins the transcript's pending calls when there is a transcript, and moves the run to `waiting_*`, like the model path).
- Mission tools are gateway tools: a task's (`createMissionBridgeToolSource`, only for `ctx.bridge.taskId`, `permission_prompt` included) on their own gateway, so a task's executor never gets the agent's other tools; a computer-brain run in a mission thread (`ctx.bridge` without a task) gets the agent-mode mission tools from `createMissionToolSource`. Same behaviour, codes, rate limits and masking as before.
- The runner relays: `tools/list` asks the server (cached per run in the MCP process, refreshed every minute, `notifications/tools/list_changed` on a change), any listed tool can be called; path resolution, secret masking and reconnect queueing stay. `toBrainSchema` (`tools/schema-compat.ts`) inlines `$ref` and flattens top-level `oneOf`/`anyOf`/`allOf` for the CLIs.

## As built: Claude Code brain and persistent processes (blocks 3b + 5)

- **Protocol 8** (`BRAIN_PROTOCOL`): request `brain.turn { runId, kind, session: {id, resume}, cwd, model?, system, prompt, mcp: {token}, keepAlive?, personalMcp?, permissions? }`; the runner streams `brain.event { runId, event }` (same shape as `BrainEvent`), then `brain.done { runId }`, and the request's result repeats the final event (`{ runId, final }`). The hub publishes the frames on `brainTopic(runId)` with the machine id, so the replica running the turn gets them wherever the socket is; the brain also ends on the reply's final event if a published one is lost. The server never sends `brain.turn` to a runner below protocol 8 (`runner_outdated`).
- **Runner** (`apps/server/runner/brain.ts`): `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, `--resume` or `--session-id`, `--model` (+ `--fallback-model sonnet` under opus), `--append-system-prompt-file` (spawned with an argv, no shell: nothing to quote), our MCP bridge (`--mcp-config`, `--strict-mcp-config` unless `personalMcp`), and the missions' command policy (`--settings` from `claudePermissionSettings`, `--permission-prompt-tool`, deny list). Text deltas are batched every 50 ms; only our bridge's tools become `tool_call` events (with `executed`); usage is `source: "plan"`; `rate_limit_event` rejected → `limit{resetsAt}` then `error plan_limit`; login failures → `error not_logged_in`.
- **Persistent process per thread**: one `claude` per (agent, session) with stdin open, closed after 10 idle minutes (`brainIdleMinutes`), at most 3 (`brainMaxProcesses`, least recently used idle one closed; all busy → one-shot); turns of a session queue; a process that dies idle is resumed on the next turn, one that dies mid-turn is replaced by a one-shot `--resume` of the same turn. Its MCP server is bound to the process; the bridge relays its calls for the run thinking at that moment (`mcp.call.taskId` = run id).
- **Login**: `hello.executors.claude` carries `loggedIn`, `authMethod` and `plan` from `claude auth status --json` (nothing else leaves the machine); `loggedIn: false` ends the turn early with `not_logged_in`.
- Error codes with `retryable: true` (the engine may fall back to the model brain): `no_session`, `machine_offline`, `exec_disabled`, `runner_outdated`, `cli_missing`, `not_logged_in`, `plan_limit`, `busy`.
