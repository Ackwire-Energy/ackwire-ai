# 0057. System mode: each agent works as its own OS user

- Status: Accepted (2026-10-24)
- Date: 2026-10-24
- Extends: ADR 0025 (connected computers), ADR 0027 (secrets to agent computers), ADR 0029 (background tasks), ADR 0030 (isolation), ADR 0056 (external provisioning)
- Code: `apps/server/runner/install-script.ts`, `service.ts`, `agent-users.ts`, `supervisor.ts`, `worker.ts`, `loopback-guard.ts`, `OP_ROUTES` in `handlers.ts`, `uploadUrl` in `push.ts`; `AGENT_WORKER_HOMES` in `packages/adapters/src/command-policy.ts`

## Context

A connected computer runs every agent's work as the OS user that runs the runner (ADR 0030, level 1). The agents on it can read each other's folders, sign-ins and browser profiles, and kill each other's processes. That is acceptable on a person's own laptop. It is not on a computer shared by agents of different people: a hosted workspace's computer, or a team's server. ADR 0030's level 3 (a dedicated user for the runner) separates the agents from the owner, not from each other.

## Decision

### 1. Install and service (Linux, root)

- `install.sh --system` installs the runner for the whole computer: a pinned Bun checked against its SHA-256 (never a `bun` from the `PATH`, which root would then run), the bundle in `/opt/agentes-runner`, the launcher `/usr/local/bin/agentes-runner`, the home `/var/lib/agentes-runner` (0700) and the root unit `agentes-runner.service` (`KillMode=process`, so a restart leaves background tasks running). Flags: `--agent-uid-range FIRST-LAST` (default 20000–29999), `--desktop`, `--no-pair`, `--no-start`, and `--enroll-file FILE` to connect with a code an external provisioner issued for this computer (ADR 0056 §10).
- The computers list says `mode: system` (from the runner's hello; `single` otherwise), so the app shows each agent working as its own user in its own folder instead of the folder the computer was connected from (root's, which no agent uses), and says allowing more takes the computer's administrator (`sudo agentes-runner folders allow …`), not the Mac app.
- `config.json` gets `mode: "system"`; pairing again keeps it. A system-mode runner never replaces itself with what the server sends: the installer updates it. `--runner-sha256 HEX` installs the bundle only when it has that hash, so whoever installs a fleet's computers can pin the runner they vouch for instead of trusting what the server serves at that moment.

### 2. One OS user per agent

- `ag-<first 8 of the agent id>`, made on the agent's first request with the lowest uid of the range that no user has and that was never handed out. `agents.json` (`[{ id, user, uid }]`) lists it before `useradd` runs, so a uid is never given twice. Users are never removed here: wiping the computer does that.
- Root runs anything as an agent through its launcher: `systemd-run --quiet --scope --collect --slice=agents-<uid>.slice -- runuser -u ag-… --` (`runuser` alone where systemd isn't PID 1), with only `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH` and `LANG`.
- Every agent's slice gets `MemoryMax=1536M`, `TasksMax=1024`, `CPUQuota=200%`, from one drop-in for the slice prefix.

### 3. A root supervisor and one worker per agent

- The root process keeps the server's socket and runs no agent work. Each op has a route in `OP_ROUTES`: `machine` ops (the computer's accounts, folder requests and reductions) are answered by root; pause is checked there before anything else; every `agent` op goes to the worker of the request's agent. A new op doesn't compile until it has a route.
- A worker is `agentes-runner worker --agent <id>`, started through the agent's launcher on the agent's first request, or at boot when it has background tasks to watch. It refuses to run as root and serves only its own agent. It has the same managers and handlers as a single runner. The agent's folder is `<handle>-<id8>` in the agent's home, as in any workspace; the home itself keeps the agent's own dotfiles.
- The worker's own state (task journal, secrets, git credentials, browser) is in `/var/lib/agentes-runner-agents/<user>` (the agent's, 0700, in a folder root owns, 0711): outside the agent's home, so the file tools never reach it, and no agent can list another's. The agent's own code runs as the same user, so the command rules treat that folder like the runner's own home: no read of it is allowed, by our check or by Claude Code's deny rules.
- The link is the machine protocol as JSON lines on the worker's stdin and stdout, the supervisor playing the server, plus frames of its own: `worker.state` (pause, the tool switches, the limits and only this agent's allowed folders, sent after each hello and on every change), `worker.close` and the upload frames (§5). Its stderr is its log, prefixed with its user in the supervisor's.
- Sessions follow the server's. When the socket drops, each worker's session ends (its requests are aborted and its MCP calls fail or wait, as in a single runner), and the worker says hello again; it is welcomed when the server is back. Pings every 10 s keep sessions up meanwhile.

### 4. What a worker may say

A worker runs as the uid the agent's own code runs as, so the supervisor takes every frame from it as that agent's word:

- `result` and `output` only for requests it was sent (under ids the supervisor gives);
- `brain.event` and `brain.done` only for its turns in flight;
- `task.event` and `task.done` only for its own tasks: `worker-tasks.json`, in root's home, records whose each task is from its `task.start` until the server acknowledges its end;
- browser frames only for its own agent;
- `mcp.call` and `mcp.list` go up only with the run's token, which the server checks, and their answers go back to that worker only. A call without a token is refused here: for those, the server takes the task id as proof of whose call it is, and other agents' task ids aren't secret on a shared computer;
- never the computer's own frames (`runner.state`, `access.*`, `accounts.changed`).

A worker that sends a line longer than a frame, or leaves 64 MB of what it was sent unread, is stopped.

### 5. Uploads without the machine token

No worker holds the machine token. For `push`, the worker reads or zips the file with its own path checks and sends the bytes to the supervisor in 1 MB pieces. The supervisor uploads them once per `push` request, with the token, to that request's URL path on the server the computer is paired with (`uploadUrl` in `push.ts`): the server builds the URL from its public address, which its own computer may not reach, and the token goes to no other host. Only the file's name, type and hash come from the worker; more bytes than the request allows are refused.

### 6. hello, restarts

- `hello.tasks` lists every task in `worker-tasks.json` as `running`, whether its worker runs or not: the server keeps them, and each worker sends `task.done` again until it is acknowledged.
- A worker that stops fails what it was running. It starts again after a backoff (1 s, doubling to 60 s while it keeps stopping soon after starting): at once when it has tasks to watch, else on its agent's next request. One that doesn't say hello within 20 s is stopped.
- When the supervisor restarts, its workers see their stdin close and exit; background tasks keep running (ADR 0029) and the next workers pick them up from their journals.

## Consequences

- Agents of different people can share one computer: files, sign-ins, browser profiles and processes belong to each agent's uid. An agent's code can rewrite its own worker's state but never get another agent's work accepted.
- A worker costs tens of MB, and only agents that work have one.
- The limits in `config.json` (tasks, brains) apply to each agent.
- Accounts (ADR 0041) stay in root's home: in a worker, a turn that names an account fails with `account_missing` until that account's folder belongs to the agent's user.
- Local ports without authentication of their own (Chrome's debugging port, the browser stream) are OS-assigned and guarded on `lo` by `table inet agentes_runner`: the supervisor learns each agent's loopback listeners and their owner uid from `ss` and limits each port to its owner's uid and to root, so one agent can't reach another's. The guard needs `nftables` (and `nft_reject_inet`, or it falls back to dropping); without `nft` it is off with a warning, which is the single-user self-host where every agent is one OS user anyway. A listing that fails keeps the rules already applied.
- The guard finds ports by scanning every 2 s, so a port that just opened is reachable by other local users until the next scan. Until that gap is closed (a check when a connection starts, or the port reserved before Chrome or the stream opens it), local ports are not a hard boundary between agents of different people.
