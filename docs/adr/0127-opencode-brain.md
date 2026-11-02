# 0127. The OpenCode brain: agents think with OpenCode's CLI, its free tier or an OpenCode key

- Status: Accepted (2026-11-02)
- Date: 2026-11-02
- Extends: ADR 0032 (computer brains), ADR 0041 (accounts per agent), ADR 0053 §3 (permission profiles), ADR 0059 (AI accounts belong to people), ADR 0114 (the Cursor brain, which this mirrors), ADR 0118 (long work pauses near a limit)

## Context

OpenCode serves its Zen models, and among them a free tier (`big-pickle`, `beam-free`, `deepseek-v4.1-flash-free`, `flint-40b-free`, `glm-5.3-flash-free`, `jev-1.13-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free` as of 2026-11-02), only to its own CLI: "Free-tier chat models require OpenCode" (opencode.ai/docs/zen). OpenCode Go already thinks through Claude Code as a coding plan (its Anthropic endpoint and an `oc_sk_` key), but the free tier and Zen's pay-as-you-go models can't reach an agent that way. The owner decided on a fifth computer brain that runs OpenCode's CLI itself, like Claude Code, Codex and Cursor.

What the CLI does, read in its source at the `v1.19.5` tag (`packages/opencode/src/cli/cmd/run.ts`, `…/models.ts`, `…/config/config.ts`, `…/provider/provider.ts`, `…/auth/index.ts`) and opencode.ai/docs/cli, …/config, …/mcp-servers, …/permissions (2026-11-02):

- `opencode run --format json [--model provider/model] [--session <id>]` prints one JSON object per line: `step_start`, `text` (a whole text part, once it ends: no smaller deltas), `tool_use` (a tool part `completed` or `error`, with `tool`, `callID`, `state.input`, `state.output` or `state.error`), `step_finish` (`part.tokens`: `input`, `output`, `reasoning`, `cache.read`, `cache.write`, and `part.cost`), `error` (`error.data.message`); every line carries `sessionID`. A failure exits 1. A piped standard input becomes the message (or is appended to the argument).
- In `run`, a permission that would ask is rejected and the model is told to go on without it (`--auto` approves instead); explicit `deny` always holds.
- `opencode models` prints `provider/model`, one per line, OpenCode's providers first. With no key for the `opencode` provider, the CLI keeps only its models with no input cost and calls them with the key `public`: the free tier needs no sign-in.
- Config is merged in order: global (`$XDG_CONFIG_HOME/opencode`), `OPENCODE_CONFIG`, the project's `opencode.json` and `.opencode/` folders (agents, commands, plugins), then `OPENCODE_CONFIG_CONTENT` last. `OPENCODE_DISABLE_PROJECT_CONFIG` skips the project's files and folders. `{env:NAME}` is substituted in all of them. Sign-ins live in `$XDG_DATA_HOME/opencode/auth.json`; `provider.opencode.options.apiKey` in the config is an OpenCode key too.
- MCP servers: `mcp.<name>` with `type: "local"` (`command` as an array, `environment`) or `type: "remote"` (`url`, `headers`); their tools are named `<name>_<tool>`.
- OpenCode has no sandbox: its permissions (`edit`, `bash`, `task`, `external_directory`, `*`…) are all that hold it.

`opencode serve` (an HTTP server with server-sent events) streams finer deltas and takes messages mid-turn, but would need a process per agent kept alive, a port and a password on the agent's computer.

## Decision

### 1. A fifth computer brain, `opencode`

`BrainKind`, `AccountKind` and `access.tools` gain `opencode` (no migration: `agents.brain`, `agent_runs.brain` and `machine_accounts.kind` are text checked in code). The engine's `OpencodeBrain` is the Codex brain with OpenCode's checks (`CliBrainSpec`, as Cursor's): runner protocol 38 (`OPENCODE_PROTOCOL`), the CLI reported in `hello.executors.opencode`, its switch on (§5). The request, the bridge token, the agent's checkouts, the permission profile and the events are shared with Codex and Cursor.

### 2. The runner: one `opencode run` per turn (`apps/server/runner/brain-opencode.ts`)

- `opencode run --format json [--model m] [--session s]`, an argv with no prompt in it; the message goes on standard input, so there is no argument limit. A new session's message leads with the engine's context (OpenCode has no system prompt flag). The `model` must be `provider/model` (the runner refuses anything else, the engine too).
- Our session → OpenCode's session (`sessionID`) lives in `<runner home>/brain/opencode-sessions.json`, per account, like Codex's threads. A runner that lost it starts a new session, with the context again.
- Everything we set rides on `OPENCODE_CONFIG_CONTENT`, merged over every other config: our MCP server alone (`agenteschat_agentes`, stdio `agentes-runner mcp --run {env:AGENTES_MCP_RUN}` with the token, socket and runner home as `{env:…}`, or the bridge's URL with the token as a bearer), the permissions (§4), `share: "disabled"`, `autoupdate: false`, and an account's key as `provider.opencode.options.apiKey: "{env:OPENCODE_API_KEY}"`. `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps a checkout's (or an earlier turn's) `opencode.json`, agents and plugins out (ADR 0117's egress half), and `OPENCODE_DISABLE_AUTOUPDATE=1` keeps a turn from updating the CLI. Nothing is written in the person's folders.
- Events: each `text` part is a `text_delta` (a paragraph apart from the one before); a `tool_use` that ended is an executed `tool_call` for the transcript, ours left out (the engine ran them); the `step_finish` tokens add up to one `usage` at the end, the input with the cache read and written; `error` fails the turn. A usage or rate limit, a 429, too little balance is `limit` then `plan_limit`; a 401 or a refused key `not_logged_in` (the account reads as signed out); anything else `opencode_failed`, retryable; the CLI missing `opencode_missing`. A clean exit with no error is `done` with the text streamed.
- No live steering: `brain.steer` answers `unsupported` for an OpenCode turn, so a person's messages wait for its end (as `codex exec` and Cursor's). Not on Windows yet.
- Detection: `opencode --version` (semver, else it isn't OpenCode's) and `opencode models`, at most 60, `free` on the free tier (§7).

### 3. Usage and limits (Model Gateway, ADR 0118)

A turn's usage is recorded like every computer brain's: tokens on the run with `org_id` and `agent_id`, `source: "plan"`, cost zero for us. The free tier costs nobody anything; a key's spend is billed by OpenCode to the person's console, never to the workspace's budget. A `plan_limit` marks the account (or the computer's own OpenCode) limited until its reset, and long work pauses near it as ADR 0118 says; OpenCode reports no usage windows, so only a refused turn says it.

### 4. Permission profiles (ADR 0053 §3)

`plan` is `{ "*": "allow", edit: "deny", bash: "deny", task: "deny", external_directory: "deny" }`: reads, searches and our tools. `work` is `{ "*": "allow", external_directory: "deny" }`: everything inside the turn's folder, with no sandbox (the agent's OS user in system mode is the boundary, as for its commands). The command policy of ADR 0053 doesn't see OpenCode's own commands. A folder outside the turn's isn't reachable, so the shared folder (ADR 0115) isn't offered to an OpenCode agent's prompt, as for Cursor.

### 5. The computer's switch

`access.tools.opencode` (protocol 38), on wherever commands are at pairing. Access stored before it has no switch: OpenCode follows Codex's there, on the runner (`effectiveAccess`, `accessToStore`) and on the server, so no computer gains a coding CLI its owner turned off. `agentes-runner tools enable|disable opencode` works as for the others; a computer's Tools in the web app lists it. The desktop app's Preferences have no OpenCode row yet.

### 6. Accounts: a sealed OpenCode key, or none

- An OpenCode account is its key alone: `begin` with `provider: "zen"` makes the folder and the key pair, the browser seals the key the person made in OpenCode's console (opencode.ai/console), and `opencode-key.json` (600) keeps it. There is no browser sign-in: `opencode auth login` only asks for the same key. A key thinks for several of its owner's agents (`loginPerAgent`), is signed in until a turn's provider refuses it, and never reaches our server.
- The account's folder is all of OpenCode's XDG folders for its turns (data, config, cache, state: sessions and sign-ins apart per account); no other OpenCode key reaches the CLI (`OPENCODE_API_KEY` and `OPENCODE_AUTH_CONTENT` join the stray sign-ins removed from its environment).
- With no account, the computer's own OpenCode thinks: whatever its owner signed in there, or the free tier with nothing. On a computer someone connected, that is theirs and thinks only for their agents (ADR 0059 §3). On a computer nobody connected (a Cloud computer), nobody signs in at its terminal, so its OpenCode is the free tier alone and thinks for anyone's agents: the engine skips both own-sign-in checks there for OpenCode, and the AI accounts list shows it as ready there.
- OpenCode picks nobody: `brain.route` stays Claude Code's and Codex's.
- Provider keys (Anthropic's, OpenAI's…) through OpenCode are not offered: the workspace's own keys already think through the Model Gateway, and a computer's owner can still sign the CLI in to any provider on their own computer.
- OpenCode Go stays a coding plan on Claude Code (`provider: "opencode"`).

### 7. Models

"Quem pensa" offers what `opencode models` listed on the agent's computer (`provider/model`), the free tier first with a "Free" mark, else, when it listed nothing, OpenCode's free tier from a static list (`OPENCODE_FREE_MODELS`, `isOpencodeFreeModel`: `opencode/…-free`, or listed). With none chosen the CLI's own default runs (`defaultBrainModel` is null); any `provider/model` is taken as typed (a key's paid Zen models, which the computer's own CLI may not list).

### 8. In the apps

OpenCode is a plan choice (`zen`, not to clash with the coding plan `opencode`) next to Claude, ChatGPT and Cursor: in Connect an AI and "Quem pensa" where a computer runs it (or the agent thinks with it), marked "Testing"; in New agent's list on such a computer. Its mark is OpenCode's own. Adding an account is the key steps (its console, the key), with a line that the free models need none. Web and phone; every new string in all fourteen languages. The engine portrait reuses Codex's terminal.

### 9. Installing the CLI

Nothing installs a coding CLI in the core: whoever runs a computer installs OpenCode's (`npm install -g opencode-ai@1.19.5`, or opencode.ai/install); `SELF_HOSTING.md` says so. In system mode the CLI must be where every agent's user can run it. The Cloud image's manifest (in the private Cloud repository) pins it system-wide: the `v1.19.5` release asset `opencode-linux-x64.tar.gz` (`sha256:588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a`; `opencode-linux-arm64.tar.gz`, `sha256:fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b`, on arm64) from github.com/anomalyco/opencode, its `opencode` binary installed as `/usr/local/bin/opencode` (0755, owned by root), with a runner on protocol 38.

## Risks we accept

- The stream, the config merge and the free tier's key-less calls rest on the CLI's source at one tag and its documentation, not yet a run on a real machine: a probe on a Cloud computer comes before the brain leaves "Testing". The JSON events are not a documented contract; the pin keeps them stable until the next deliberate upgrade.
- No sandbox: in `work`, OpenCode runs anything as the agent's user inside the turn's folder; `plan` holds only by OpenCode's own permission checks.
- Text arrives a paragraph at a time, not word by word.
- A computer's own OpenCode on a computer someone connected may carry its owner's sign-ins; it thinks only for their agents.
- OpenCode's terms on the free tier (it may train on what it is sent) are the person's and the workspace's to accept; nothing here changes them.

## Consequences

- Runner protocol 38; the server never sends `kind: "opencode"` (turns or accounts) to an older runner, which shows OpenCode as "Update the agentes.chat program".
- Tests: a fake OpenCode CLI (`apps/server/test/runner/fake-opencode.mjs`) for the runner's turns, sessions, keys, limits and redaction; the engine's brain, availability, options and free tier; the clients' plan choice and picker.

## Alternatives considered

- **`opencode serve` with its SSE events**: word-by-word text and messages mid-turn, at the cost of a long-lived server per agent with a port and a password on the computer; `run` first, the server as the upgrade if steering or finer streaming are missed.
- **Zen's API from the Model Gateway**: refused for the free tier (OpenCode-only), and the paid models would bill the workspace rather than the person's console.
- **Writing an `opencode.json` in the agent's folder** (Cursor's way): `OPENCODE_CONFIG_CONTENT` needs no file and wins over any other config.
