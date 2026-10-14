# 0015. Tool Gateway, scopes and approvals; runs as resumable tool loops

- Status: Accepted
- Date: 2026-10-14
- Implements planejamento D2 (Tool Gateway), D3 (resume), D4 (approvals bound to the exact action). Extends 0008.

## Decision

**Tools.** A `ToolDefinition` (name, description, JSON Schema input, `scope`, optional `connectionId`, `sensitive`, `describe`, `execute`) comes from a `ToolSource` (built-in tools, MCP connectors, sandbox). Sources never decide permissions.

**Scopes.** `agent_scopes (agent_id, connection_id, scope)` holds what an agent may do; `connection_id` null is a built-in scope (`context:read`, `memory:write`, `drive:*`, `issues:write`, `sandbox:exec`). Grants are validated against the built-in list or the connector catalogs; nothing else can be granted.

**Tool Gateway** (`createToolGateway`), the only path from a model's tool call to execution:
1. look the tool up by name among the run's sources (the model's description of it is irrelevant);
2. check the scope in `agent_scopes` (database read on every call; no prompt can change it);
3. validate the input against the tool's JSON Schema (inputs stream eagerly, so the provider doesn't validate);
4. sensitive tools (flagged by the source, or any tool whose name or scope says merge, deploy or rollback) create an `approvals` row and stop; others run, with exceptions turned into error results;
5. record `tool_call`, `tool_result` and `approval` steps.

**Approvals.** A row stores the tool, scope, connection, params and `action_hash = sha256(canonical JSON of all four)`, a title/detail for people, `expires_at` (24 h), and the agent's owner (snapshot). The agent's owner and org admins may decide (`decideApproval`); the decision and the job that resumes the run commit in one transaction. `executeApproved` re-checks the hash against the stored params, re-checks the scope (it may have been revoked while waiting), claims `executed_at` (never twice), and runs exactly the stored params. Refused or expired requests become an error tool result with the reason. A worker expires pending approvals every minute. Events `approval.created` / `approval.decided` go to the channel and to each approver's user topic.

**Runs as tool loops.** `agent_runs.transcript` holds the conversation sent to the model (system blocks, messages with neutral content blocks, pending tool calls) and is saved after every turn. It is append-only: a resumed run sends exactly the same history plus the tool results, which keeps provider thinking blocks valid and prompt caches warm. The executor loops model call → tool calls → results until the model answers or `AGENT_MAX_TOOL_TURNS` is reached. On a sensitive call it posts what the agent said so far plus one approval card per request (`messages.meta.approvalId`), saves the pending calls, and moves the run to `waiting_approval` in one transaction. A run resumes only when all of its approvals are decided.

## Consequences

- A retried job continues from the saved transcript. A crash between running a non-sensitive tool and saving can repeat that tool; sensitive actions can't repeat (`executed_at`).
- Tool results are capped at 50 000 characters for the model and 4 000 in steps.
