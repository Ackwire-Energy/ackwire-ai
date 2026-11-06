# 0150. How each Claude connection signs in: kept per connection, chosen by the operator for new ones

- Status: Accepted (2026-11-05; built: the runner, the engine, the operator API, the shared client, the web and the phone app)
- Date: 2026-11-05
- Extends: ADR 0041 (accounts per agent), ADR 0056 (operator API), ADR 0059 (AI accounts belong to people)
- Amends: ADR 0059 §2 (the method a Claude sign-in for all agents uses is per connection and chosen by the operator for new ones; an unchecked status is not signed out), ADR 0056 §4 (the Claude sign-in policy and the AI-accounts reads) and §5 (`account.failure`, a failed `run.finished`'s `failure`)
- Code: runner protocol 47 (`CLAUDE_AUTH_PROTOCOL`, `AuthMethod`, `ProviderFailureCause`, `claudeLoginMethodsOf` in `packages/adapters/src/machine-protocol.ts`); runner `apps/server/runner/accounts.ts` (the `<id>.method` marker, `authMethod`, `statusUnknown`, `begin`'s `method`), `brain.ts` (`cause`, `httpStatus`), `agent-users.ts` (`authEgressPrefix`); migration `0226_claude_auth` (`machine_accounts.auth_method`, `status_unknown`, `provider_org_id`, `last_failure_cause`, `last_failure_at`, `last_success_at`; `claude_auth_settings`); engine `packages/engine/src/claude-auth-policy.ts`, `machine-accounts.ts`, `operator-events.ts`, `ai-accounts-analytics.ts`; operator routes `apps/server/src/operator/claude-auth.ts`, `analytics.ts`; client `packages/client/src/lib/ai-accounts.ts`

## Context

A Claude subscription signs in on a computer in one of two ways. Where every agent is the runner's own user, the CLI's own `claude auth login` keeps and refreshes its sign-in in the account's folder. Where each agent is its own OS user (`install.sh --system`), a sign-in made for all of its owner's agents has used `claude setup-token` (ADR 0059 §2): root keeps the long-lived token and hands it to each turn on a descriptor. Nothing recorded which way a connection signed in, so the method couldn't be changed for new connections without guessing about old ones, and nobody could count them.

Three more gaps: a status look that timed out or printed nothing readable made a connection read as signed out; a turn the provider refused said only `not_logged_in` or `claude_failed`, never why; and the operator had no view of the AI accounts people connect.

## Decision

### 1. Every connection keeps its method

`AuthMethod` is `cli_login` (the CLI's own sign-in), `setup_token` (root's token) or `api_key` (a coding plan's, Cursor's or OpenCode's pasted key). The runner writes the method into a root-owned `<id>.method` (600, beside the folder, like `<id>.shared`) when a sign-in begins, keeps it when it signs in again and removes it with the account. It reports `authMethod` on every account from reliable facts only: the marker, else a key file (`api_key`), a token root keeps for all agents (`setup_token`), or a CLI folder whose sign-in finished (`cli_login`). Anything else is left out, never guessed. The server stores it in `machine_accounts.auth_method` (null: unknown) and keeps the stored value when a report says nothing. A key or a CLI's own sign-in is stored at `begin` already.

Signing in again uses the connection's method. A `begin` with `again` that names another method than the marker's is refused (`bad_request`, "This account signs in another way"): a connection never changes its method silently.

### 2. The operator chooses the method of new Claude sign-ins for all agents

`claude_auth_settings` is one row for the installation: `method` (`cli_login` or `setup_token`), `rollout` (`selected` or `all`) and `org_ids` (up to 500). No row is `setup_token`, `selected`, no workspaces: what runners always did. The effective method of a new Claude subscription sign-in for all agents on a computer of workspace O is `cli_login` where agents are not their own OS users; where they are, `cli_login` only when the policy says `cli_login` and the rollout is `all` or lists O, else `setup_token` (`claudeAuthMethodFor`).

`beginAccountLogin` resolves it once for a new connection, stores it on the `signing_in` row and sends it in `begin` (`method`). A reconnect uses the row's method and never reads the policy, so changing the policy reaches only sign-ins started after it. The operator sets it with `PUT /api/operator/v1/claude-auth` (validated, workspaces deduplicated and checked, `claude_auth.unknown_org` otherwise; setting the same policy changes nothing) and reads it, with the Claude subscription connections counted by method, at `GET /claude-auth`; `GET /orgs/{orgId}/claude-auth` gives a workspace's effective method and, per computer, whether each agent is its own OS user, its protocol, what its runner can use and whether that covers the effective method.

### 3. Capability negotiation, never a fallback

`hello.claudeLoginMethods` says which methods a new Claude sign-in for all agents can use on that computer: `["cli_login"]` where agents are the runner's own user, `["setup_token"]` where each is its own OS user (§Not done). A runner older than 47 says nothing and is read as what it did (`claudeLoginMethodsOf`). When the effective method is one the runner can't use, `beginAccountLogin` refuses with `account.method_unsupported` (409) before any row is made; it never falls back to the other method. A runner that gets `method: "cli_login"` for a shared sign-in in system mode refuses it too (`unsupported`), and `setup_token` outside system mode or without `shared` is `bad_request`. `method` goes only to protocol 47 runners, and only for a Claude subscription (no `provider`).

### 4. An unchecked status is not a signed-out one

A status look that timed out, didn't start or printed no readable answer reports `statusUnknown: true`, with `loggedIn` the last conclusive answer the runner had. Only the CLI's explicit `loggedIn: false` or a turn the provider refused (`<id>.invalid`) is signed out. The server keeps a listed connection's status as it was and sets `status_unknown`; a conclusive report clears it. The apps say the computer couldn't check the account and checks again by itself (`statusKnown` false), with no "signed out" and no Sign in again for that. One status look or usage probe per account runs at a time. `auth status --json`'s `orgId` and `orgName` are kept as `provider_org_id` and `org_name` (opaque, no secret); one email in two of Claude's organizations is two accounts.

### 5. Why a provider failed a turn

The runner reads Claude Code's own error frames (`api_retry` with its `error` and `error_status`, an `assistant` frame's `error`, a rejected `rate_limit_event`, the error result's text and status) into a `cause` (`auth_rejected`, `account_disabled`, `quota`, `billing`, `provider_transient`, `network`, `unknown`) and the provider's `httpStatus` on the turn's error, beside the codes it already sent. A 401, `authentication_failed` or a 403 alone is `auth_rejected`; `account_disabled` only when the provider's own error says the account or organization is disabled or suspended. The model's prose never sets a cause.

The engine keeps the cause and time on the account (`last_failure_cause`, `last_failure_at`; from the code when the runner gave no cause) and `last_success_at` on a turn that ran. With operator events on, a provider or sign-in failure writes `account.failure` (account, computer, kind, method, cause, code, HTTP status, runner version and protocol; at most one per account and cause every 10 minutes per server process), and a failed `run.finished` carries `failure: { code, cause }`. Metadata only, as every event (ADR 0056 §5).

### 6. The operator reads the AI accounts people connected

`GET /analytics/ai-accounts?from&to` (at most 400 days) counts connections (active and signed out; signing in and removing apart, deleted not at all), usable, unchecked, signed out, the workspaces with one, use in the last day and week, API credentials and their workspaces, and the computers' own sign-ins per computer and brain (never added to connections); a breakdown by provider, runtime, method and billing; how many connections carry a provider identity (kind, email and provider organization, counted only where both are known); failures by cause and method from `account.failure` (attempts, accounts, workspaces, the 50 most recent); additions by day from the connections kept (`addedSource: "retained_rows"`) and coverage notes. `GET /ai-accounts` lists connections in keyset pages (`created_at desc, id`, 1–200) filtered by workspace, kind, method (`unknown` too) and status. No answer carries an email, key hint, token or provider organization id, and none calls a computer, a CLI or a provider.

### 7. Root's Claude sign-in children in their own group

Where each agent is its own OS user, root runs Claude's `setup-token`, `auth login`, `auth status` and `auth logout`, and the usage probe of an account folder root keeps, as `setpriv --regid=<gid> --clear-groups --` with the gid of a system group `agentes-auth` the runner makes once (`groupadd --system`, nobody a member). Its uid stays root's; only the group marks the sockets, so a computer's egress rules can send those connections (and nothing else of root) where its agents' traffic goes, apart from the agents' own rules and from the method. Without `setpriv` or the group the children run as before, said once in the log. `hello.authEgressGroup: true` says it is on, and the server keeps it with the computer's executors. Codex, the computer's own sign-in and every other root process are untouched, and with no rule on the group nothing routes differently.

### 8. Taking it back

The policy is the switch: `setup_token` (or no workspaces listed) makes every new Claude sign-in for all agents a token again, as before. Connections made meanwhile keep their method until they are removed; signing one in again keeps its method, so moving it means removing it and connecting again. Everything here is behind protocol 47: older runners get no `method`, report no new fields, and the server reads their silence as before.

## Not done

Claude's own login for a sign-in made for all agents where each agent is its own OS user stays unavailable until an isolated execution design ships: the CLI would have to run as the user that owns its credential file, while the agent's own tools must not run with that user's access to it, and nothing in the runner provides that boundary today. Until then such a runner never advertises `cli_login` in `claudeLoginMethods`, the server refuses a new sign-in there whose effective method would need it (`account.method_unsupported`), and the one-agent sign-in lent to that agent's user stays as it is.

## Consequences

- Every Claude connection says how it signs in, and the operator can count them, change the method for new ones per workspace or for all, and see where a runner can't follow.
- A slow or broken status look no longer shows an account as signed out, and a refused turn says why the provider refused it.
- Root's Claude sign-in traffic can be routed apart from the rest of root on computers whose egress rules match the `agentes-auth` group; elsewhere nothing changes.
