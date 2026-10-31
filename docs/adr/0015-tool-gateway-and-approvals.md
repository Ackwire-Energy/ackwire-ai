# 0015. Tool Gateway, scopes and approvals; runs as resumable tool loops

- Status: Accepted
- Date: 2026-10-14
- Extends 0008.

## Decision

**Tools.** A `ToolDefinition` (name, description, JSON Schema input, `scope`, optional `connectionId`, `sensitive`, `describe`, `execute`) comes from a `ToolSource` (built-in tools, MCP connectors, sandbox). Sources never decide permissions.

**Scopes.** `agent_scopes (agent_id, connection_id, scope)` holds what an agent may do; `connection_id` null is a built-in scope (`context:read`, `memory:write`, `drive:*`, `issues:write`, `sandbox:run`). Grants are validated against the built-in list or the connector catalogs; nothing else can be granted.

**Tool Gateway** (`createToolGateway`), the only path from a model's tool call to execution:
1. look the tool up by name among the run's sources (the model's description of it is irrelevant);
2. check the scope in `agent_scopes` (database read on every call; no prompt can change it);
3. validate the input against the tool's JSON Schema (inputs stream eagerly, so the provider doesn't validate);
4. sensitive tools (flagged by the source, or any tool whose name or scope says merge, deploy or rollback) create an `approvals` row and stop; others run, with exceptions turned into error results;
5. record `tool_call`, `tool_result` and `approval` steps.

**Approvals.** A row stores the tool, scope, connection, params and `action_hash = sha256(canonical JSON of all four)`, a title/detail for people, `expires_at` (24 h), and the agent's owner (snapshot). The agent's owner and org admins may decide (`decideApproval`), except a `request_permission` approval, which turns a connector or a built-in scope on for good: only admins (`manage_agents`) decide it (`adminsDecide`), as only they give an agent new access (ADR 0016); the decision and the job that resumes the run commit in one transaction. `executeApproved` re-checks the hash against the stored params, re-checks the scope (it may have been revoked while waiting), claims `executed_at` (never twice), and runs exactly the stored params. Refused or expired requests become an error tool result with the reason. A worker expires pending approvals every minute. Events `approval.created` / `approval.decided` go to the channel and to each approver's user topic.

**Runs as tool loops.** `agent_runs.transcript` holds the conversation sent to the model (system blocks, messages with neutral content blocks, pending tool calls) and is saved after every turn. It is append-only: a resumed run sends exactly the same history plus the tool results, which keeps provider thinking blocks valid and prompt caches warm. The executor loops model call → tool calls → results until the model answers or `AGENT_MAX_TOOL_TURNS` is reached. On a sensitive call it posts what the agent said so far plus one approval card per request (`messages.meta.approvalId`), saves the pending calls, and moves the run to `waiting_approval` in one transaction. A run resumes only when all of its approvals are decided.

## Consequences

- A retried job continues from the saved transcript. A crash between running a non-sensitive tool and saving can repeat that tool; sensitive actions can't repeat (`executed_at`).
- Tool results are capped at 50 000 characters for the model and 4 000 in steps.

## Addendum (2026-10-30): "Aprovar sempre"

A person who decides an agent's approvals may approve a kind of call for good, so the agent stops asking for it. The kind is the agent, the connection, the server's own tool name and each action that tool runs (Composio's executor, ADR 0016); never the params. Only a tool that names what each call does can be remembered: any other tool approved for good would run with any params (a raw request, a GraphQL mutation, code), so a custom server's other tools keep asking, and an admin who wants one to stop sets it to Escrever. Rules live in `approval_rules (org_id, agent_id, connection_id, tool, action)`, `action = ''` for the tool itself when a source remembers one that runs nothing else, unique per kind.

- **Offered** only where the gateway says so when it asks, stored on the request (`approvals.approve_always = { tool, actions }`, null = not offered): a person's run whose policy didn't force the ask (routines, unattended work and missions always ask, ADR 0053), a tool its source lets be remembered (`ToolDefinition.rememberAs`, on custom servers only the executor), with known wrapped actions none of them sensitive (`actionLevel`: a send, delete or payment in any word form, such as `SLACK_DELETES_…`, `GMAIL_REPLY_…`, `SLACK_CHAT_POST_MESSAGE` or `VERCEL_BUY_…`), and nothing in its names, scope or actions that matches merge, deploy or rollback, has a word starting with merge, deploy, redeploy, rollback, revert, restore, promote, workflow, build, dispatch, reference, release, alias, rolling, rerun or rerequest (a repository dispatch starts workflows, a reference moves a branch, an alias or a rolling release takes production traffic), has commit, trigger, run, execute or invoke right after its app, or is open-ended (`openEnded`: GraphQL, SQL, a proxy, a query it runs, whose arguments say what it does). Never on built-ins (mail has its own switch), catalog connectors, the code runners and Composio's proxy, or a high-risk card that takes a hold.
- **Deciding** is `POST …/approvals/{id}/approve` with `always: true`, by the same people as the approval (`mayDecide`). The rules are written in the decision's transaction, and the `approval.approved` audit row carries `always`. Where it isn't offered: 409 `approval.always_unavailable`.
- **Honoured** in the approval branch after the scope, schema, credential and argument checks and before the "say why" refusal: a covered call (one fresh query, no cache) runs like an allowed one, with its team action and a `tool.call` audit row with `details.approvalRules`. A rule never grants access: losing the scope, a denial or a tool turned off or sensitive stops it before any rule is read.
- **Undone** on the agent's page (Ferramentas e acesso, "Aprovado sempre", `GET`/`DELETE …/agents/{agentId}/approval-rules`), by admins and the agent's owner, audited as `agent.approval_rule_removed`. Disconnecting the server and deleting the agent delete its rules.
