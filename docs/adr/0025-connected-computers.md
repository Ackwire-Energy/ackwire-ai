# 0025. Connected computers, provider-agnostic computers, and binary files in the Drive

- Status: Accepted
- Date: 2026-10-15
- Planning: D36

## Context

An agent's computer (ADR 0021) is always a Daytona sandbox we create. People want agents to work on machines they already have (a VM in any cloud, a server at the company, a laptop), with their own tools installed (for example Claude Code signed in to a personal plan), and to bring what they produce into the Drive. The Drive only stores text kinds (`document`, `table`, `diff`, `html`, `diagram`) and `export_file` reads at most 5 MB through the model's tool path.

## Decision

### 1. A computer is a lifecycle plus a channel

`SandboxProvider` is split in two contracts (`packages/adapters/src/sandbox.ts`):

- **`ComputerLifecycle`**: `create`, `get`, `ensureStarted`, `stop`, `destroy`, `setNetwork`.
- **`ComputerChannel`**: `exec`, `execStream?`, `writeFile`, `readFile`, `listFiles`, and the new `pushFile?`.

`SandboxProvider = ComputerLifecycle & ComputerChannel` keeps Daytona and the fake unchanged. Tools receive the computer they act on as `{ id, provider }`, never a single global provider, so one server can serve Daytona computers and connected machines at once.

Combinations:

| Computer | Lifecycle | Channel |
|---|---|---|
| Daytona (today) | Daytona API | Daytona toolbox API |
| Connected machine (this ADR) | none: it is on when its runner is online | our runner over WebSocket |
| A VM in any cloud (later) | that cloud's API (start/stop) | our runner, baked into the image and paired once |
| E2B, Modal, Fly… (later) | their API | their API |

A new provider is a lifecycle adapter; the runner already covers the channel.

### 2. `pushFile`: the machine sends the bytes, the model never sees them

`pushFile(id, path, target)` asks the computer to send a file (or a folder, zipped) straight to a one-time upload URL of ours. `target` is `{ url, uploadId, maxBytes }`; the runner authenticates the PUT with its own machine token, so no storage credential ever leaves the server.

Channels without `pushFile` (Daytona) fall back on the server: a folder is zipped inside the computer with `python3 -m zipfile`, then the server reads the file with `readFile` and stores it itself. Both paths end in the same `completeUpload`.

### 3. Binary files in the Drive

A new artifact kind `file` (migration adds the enum value): any bytes, with the original name, MIME type, size and SHA-256 in the version row.

- Limit: 50 MB per file version (`ARTIFACT_LIMITS.fileBytes`).
- Always `untrusted`: downloaded as an attachment with `nosniff`, never rendered on the app's origin. The app previews only raster images (`png`, `jpeg`, `gif`, `webp`) and PDF from a download URL; `svg` and everything else is download-only.
- Search indexes the title and file name only.
- `read_artifact` returns the metadata (and the text of small UTF-8 text files); `import_file` copies the bytes back into a computer.
- Versions work like other kinds (`upload_file` with `artifact_id`).

### 4. `upload_file` tool

`upload_file(path, title?, artifact_id?, note?)`, scope `sandbox:run` (same as `export_file`). A file goes as is; a folder becomes `<name>.zip`. The tool creates an `artifact_uploads` row (pending, bound to org, agent, run and computer, expires in 10 minutes), asks the channel to push, waits for completion (pub/sub signal plus a database poll, so it works across replicas) and answers with the artifact id and version. `export_file` stays for text that should become a native kind.

### 5. Connected machines and the runner

**Runner.** `apps/server/runner` (inside the server package, so no new workspace changes the frozen lockfile): one JavaScript bundle (`agentes-runner.mjs`) that runs on Node 22+ or Bun on Linux, macOS and Windows. It is built with the web app and served at `/runner/agentes-runner.mjs`; `GET /api/machines/install.sh` installs it.

- `pair --server <url> --code <code> [--dir <workspace>] [--no-exec]` trades a pairing code for a machine token and writes `~/.agentes-runner/config.json` (mode 600).
- `start` connects and stays connected (reconnects with backoff). `service` installs a systemd user unit or a launchd agent.

**Pairing.** A member creates a pairing (`POST …/machines/pairings`, a name): a code `XXXX-XXXX`, single use, 10 minutes, stored hashed. `POST /api/machines/pair` (no session, rate limited) trades it for a machine row and a token `agm_<32 random bytes, base64url>`, stored as SHA-256. Deleting the machine revokes the token and closes its socket at once.

**Connection.** Outbound WebSocket to `/api/machines/connect`: no public IP, port or tunnel on the machine. The first frame is `hello` with the token (not a header: Node's WebSocket client can't set one); no valid `hello` in 10 s closes the socket. Then the server sends `welcome`, pings every 25 s, and marks the machine offline when the socket closes. `machine.status { machineId, online }` goes to the organization.

**Protocol.** `packages/adapters/src/machine-protocol.ts` (shared by server and runner): `request { id, op }` with `exec`, `read`, `write`, `list`, `push`; `output` frames while a command runs; `result { id, ok, data | error }`; `cancel { id }`. Files travel base64 inside JSON for `read`/`write` (5 MB); uploads always use `push`.

**On the machine.**
- Every path is relative to the workspace folder chosen at pairing (default `~/agentes`); `..` and absolute paths are refused, and symlinks that leave the workspace are refused for reads, writes and uploads.
- Each agent works in its own folder of the workspace, `<handle>-<first 8 of id>` (protocol 2: every request carries `agent: { id, handle }`). The runner creates it on first use, treats it as that request's workspace (`/workspace` for the agent, `cwd` of its commands), and finds it by the id suffix after a rename. Many agents can share one computer without seeing each other's files through the file tools; a shell command can still `cd` anywhere the OS user can. The server refuses tools on runners older than protocol 2 (they would ignore `agent`), and `agentes-runner update` replaces the bundle and restarts the service without pairing again.
- Commands on a connected computer may run up to an hour (`machineMaxTimeoutSeconds`; ours stay at 10 min): it costs us nothing and tools like Claude Code take minutes. `run_code` tells the agent to drive Claude Code with one session per conversation (`claude -p --session-id <thread id>` the first time, `--resume <thread id>` after), so it keeps context across turns; sessions are per folder, so each agent's are its own.
- Commands run as the user that runs the runner, with `cwd` in the workspace. A shell command can reach anything that user can, so the install guide recommends a dedicated OS user. `--no-exec` turns commands off (files and uploads only); `run_code` then says so.
- The runner never receives secrets from us. Whatever the machine already has (a Claude Code login, SSH keys) stays there and is used under the machine owner's responsibility.

**Across replicas.** The replica holding the socket executes requests. Another replica writes the request to `machine_rpc` and signals the holder through pub/sub; the reply comes back the same way (Postgres `NOTIFY` payloads are too small for file bodies). Live output streaming works only on the replica holding the socket; elsewhere the command reports its output at the end.

### 6. Which computer an agent uses

`agents.machine_id` (nullable). Null: the Daytona computer (when the server has one). Set: that connected machine.

- Who sets it: an admin (`manage_agents`), or the agent's owner when they also paired that machine.
- `GET …/agents/{id}/computer` adds `target: { kind: "cloud" } | { kind: "machine", machineId, name, online }`.
- A connected machine costs us nothing: no `usage_records`, no daily minutes, no budget check. Commands and uploads are audited (`machine.exec`, `artifact.uploaded`).
- The org's network mode and the git proxy setup (ADR 0024) do not apply: we don't control that network, and we never rewrite a person's global git config. `computer_status` tells the agent it is on "<name>" (online or offline).
- Offline machine: tools fail with "the computer <name> is offline" and the agent tells the people. We can't power on a machine we don't control (a cloud lifecycle adapter will).
- Tools exist when the server has Daytona or when the agent has a machine, so a self-hosted server without Daytona can still give agents computers.

### 7. API

- `GET /organizations/{orgId}/machines`: id, name, online, lastSeenAt, hostname, os, arch, runner version, exec allowed, paired by, agents using it.
- `POST …/machines/pairings` `{ name }` → `{ code, expiresAt, installCommand }`.
- `PATCH …/machines/{id}` `{ name }`; `DELETE …/machines/{id}` (the person who paired it or an admin).
- `PUT …/agents/{agentId}/computer/target` `{ machineId: uuid | null }`.
- No session (machine token or code): `POST /api/machines/pair`, WebSocket `/api/machines/connect`, `PUT /api/machines/uploads/{uploadId}`, `GET /api/machines/install.sh`.

## Consequences

- Agents can run anything installed on a machine people trust, and their files land in the Drive without passing through the model.
- Every cloud with an API can become a provider with only a lifecycle adapter.
- Shell commands on a connected machine are as powerful as that OS user; isolation is the machine owner's choice (dedicated user, container, VM).
- A pending upload that never completes expires; the tool times out with a clear message and nothing is stored.
