# 0060. One-command install, native mode, and the server's computer

- Status: Accepted. Built: the installer, the server's computer, plain words and the usage report (§5). Not built yet: native mode (§2), so a Mac needs Docker for now, and the setup's questions for the server's computer (§3) and the usage report (§5), set by hand until then (`SELF_HOSTING.md`).
- Date: 2026-10-24. Revised 2026-10-25: the usage report is built, on by default with a way to turn it off (§5)
- Extends: ADR 0003 (PGlite), ADR 0025 (connected computers), ADR 0030 (isolation on computers), ADR 0036 (one runner per organization), ADR 0041 (accounts on a computer)
- Out of scope for now: Windows, a container image as the agents' computer, native mode as a server database at scale

## Context

Self-hosting starts with the setup wizard (`npx @agenteschat/setup`, which needs Node.js, or the same wizard from the app's image) and needs Docker with Compose ≥ 2.23.1. Distribution packages differ: Debian 13's `docker.io` has no Compose plugin, and Debian 12's `docker-compose` is Compose v1. Most Macs have no Docker, and installing a VM just to try an app is the friction that stops people.

After the install, agents still need a computer, and on a fresh server nobody has connected one yet (ADR 0025). And the screens about computers (onboarding, preparing, the computer's page) are read by people who aren't developers.

## Decision

### 1. One command

`curl -fsSL https://agentes.chat/install | sh`. The script is `install.sh` at the repository root (POSIX `sh`, short enough to read), served by every instance at `GET /install` and `/install.sh`, and attached to each release. It only bootstraps, then hands off to the existing wizard, which keeps every check and fix:

- **Platform:** macOS or Linux on x64 or arm64. Anything else (32-bit, Windows) gets a message and a link to `SELF_HOSTING.md`; WSL2 follows the Linux path.
- **Cut-off downloads:** the whole script is one `main` function, called on the last line, so a partial download runs nothing.
- **Terminal:** it uses `/dev/tty` only when it opens (`(exec </dev/tty) 2>/dev/null`). `[ -r /dev/tty ]` is true with no controlling terminal (cloud-init, CI), where opening it fails. Without a terminal the wizard gets `/dev/null` (defaults plus flags), because under `curl | sh` stdin is the rest of the script.
- **Docker (Linux):** Docker's own install script runs only after a yes (or `--yes`), and never when `docker` exists. When Compose v2 ≥ 2.23.1 is missing, it installs the official plugin binary, pinned with its SHA-256 in the script, instead of relying on package names (in Docker's system plugin folder as root, in the user's own otherwise). Without root and without access to Docker, it runs itself again with `sudo`: the same file under `sh install.sh`, or, under `curl | sh` where there is no file, the published installer.
- **Bun:** a pinned version with its SHA-256 in the script, unless a new enough `bun` is on `PATH`. On x64 it's the `-baseline` build, because server CPUs may lack AVX2. musl systems are refused with a clear message.
- **Hand-off:** `cd` to the install folder, then `bun x --bun @agenteschat/setup@<version>` with the flags passed through.
- **Flags:** `--dir`, `--yes`, and `--plan` (or `--dry-run`), which prints each decision and the commands it would run and runs nothing (what the tests assert). `--native` comes with native mode; until then it says so and stops. Every other flag goes to the wizard, and a test checks the wizard accepts every option the installer hands it; with its `--json`, the installer's own lines go to stderr. `AGENTES_INSTALL_SETUP` points at a local build of the wizard. A version is held the compose file's way, with `AGENTES_IMAGE` in `.env`.
- **Folders:** `/opt/agentes` as root, `~/agentes` for a user who can already use Docker, `~/.agentes` in native mode.
- The docs also show "download, read, then run".

### 2. Docker or native

- **Linux:** Docker and Postgres (the compose file).
- **macOS:** Docker when an engine answers within 5 seconds (Docker Desktop, OrbStack, Colima). When Docker is installed but doesn't answer, it says "start Docker, or pass `--native`", because moving from native to Docker later is a dump and restore. With no Docker at all it goes native and says why. Until native mode is built, a Mac without a Docker that answers is told to install or start one, and nothing else runs.
- **Native mode** is Bun plus PGlite, selected by `DATABASE_URL=pglite:///absolute/folder`. It's the same WASM Postgres with pgvector the tests run on (ADR 0003), so the migrations and the SQL are the same, with no native binaries. Embedded Postgres binaries have no pgvector, and Homebrew or Postgres.app are one more install.

**PGlite's limits, and what the adapter does about them:**

- One process, queries one at a time, small teams and data, 0.5 to 1 GB of memory. Servers should use Docker; moving there is a dump and restore.
- Back-to-back queries starve the event loop (timers stop firing), so the adapter yields with `setImmediate` after every query, on transaction handles too.
- Two processes open the same data folder without an error, so the folder is locked with a pid file (the runner's lock helper, shared).
- PGlite's data format changes when it moves to a new Postgres major version. PGlite is pinned exactly, and its version is stored next to the data. When a release changes it, the upgrade stops the service, dumps with the old bundle, restores with the new one, and keeps the old folder. A copy of the data is only ever taken with the service stopped.
- One process means the in-memory pub/sub.

**Packaging and service:**

- Each release has `agentes-native-<version>.tar.gz` and `SHA256SUMS`, checked before extracting. It extracts to `~/.agentes/app/<version>`, with `current` as a symlink and the previous version kept.
- `~/.agentes/.env` is written with mode 600, with `HOST=127.0.0.1`.
- The service is a launchd agent on macOS, or a systemd user unit on Linux (with `loginctl enable-linger`). A Mac mini that must come back after a power cut needs automatic login or a LaunchDaemon; the docs say how.
- Upgrading is running the same command again.
- With `PUBLIC_URL=http://localhost`, the phone's QR code can't reach the server, and the wizard says so. When the Tailscale CLI is there, it offers `tailscale serve` and writes the `ts.net` address.

### 3. The server's computer

The machine that runs agentes.chat is also a computer for its agents, "Computador deste servidor". It's on by default: the wizard asks, saying what it adds, and `--computer no` skips it. Until the wizard asks, it's set up by hand: the token in `.env`, then the runner's install (`SELF_HOSTING.md`).

- **Linux:** the runner is installed on the host in its system mode: a root supervisor that runs no agent code, and each agent as its own OS user with its own folder and memory limit. A container isn't used, because Chrome's sandbox doesn't start in a container with dropped capabilities and the default seccomp and AppArmor profiles, `--no-sandbox` next to every organization's tokens is not acceptable, and a container can't hold one OS user and one desktop per agent.
- **macOS:** the runner on the Mac. Agents run as the person there, so with native mode the wizard keeps their commands off until the person says yes ("they run as you and can reach this server's files"). A dedicated macOS user is the safer yes (ADR 0030). Run by hand, `agentes-runner host` turns commands on unless given `--no-exec`, like `pair`.

**How it joins organizations:**

- `HOST_COMPUTER_TOKEN` (generated by the wizard, at least 32 characters) is given only to the runner. It's compared with `safeEqual`, never logged and never sent to browsers.
- The runner calls `POST /api/machines/host/sync` (no session, rate limited). The answer has one machine row per organization, with `machines.kind = 'host'` (the values are `connected`, `host` and `managed`). Each row has its own ordinary machine token, stored as a SHA-256.
- The runner (`agentes-runner host`) keeps one runner home and one child runner per organization (as the desktop app does, ADR 0036), syncs every minute and starts a child again with a backoff when it stops. Each child speaks the normal protocol, so outages, accounts and brains work unchanged.
- On Linux each child is a system-mode runner. Each organization's agents take uids from a block of 100 of their own, so two children never hand out the same uid, and the host keeps one loopback guard for all of them (one per child would replace the others' rules). That allows 100 organizations in the default range.
- A row with no token gets a new one at the next sync (after it's turned back on, say). A child whose token is refused makes the runner ask for a new one at once. A server started with another `HOST_COMPUTER_TOKEN`, or none, retires every row's token: each row keeps a hash of the one it was issued under.
- The runner turned off on the server (404) or refused (401) stops its children and waits. A server it can't reach leaves them running.
- Installing it on Linux, as root: `install.sh --system --server http://127.0.0.1:<port> --host-token-file <file>`. `--server` is where this machine reaches the server, since people may use an address the machine itself can't reach, and the service reads the token from the file (root only). Elsewhere: `agentes-runner service install --host --server … --token-file …`.

**Which organizations it serves:**

- Only organizations the installation's first account (the person who set it up) made and is still an owner or an admin of. Its rows are paired by that account.
  - So that person is the computer's owner for ADR 0041: they add the Claude and ChatGPT sign-ins on it, and pick them per agent. For ADR 0059 §1 it is a computer someone paired, so only they add accounts there, and their plans think only for their own agents (ADR 0059 §3); other members' agents there think with a key.
  - Someone who joins through an invitation and then creates an organization of their own doesn't get agents on the operator's machine. A role isn't enough on its own, since an organization's owner can make anyone an admin or an owner there; who made an organization is recorded on its #general, which can't be renamed or archived.
  - The server refuses to start with `HOST_COMPUTER_TOKEN` and `ALLOW_SIGNUP=true` together: with open sign-up, a stranger could be the installation's first account. Nor with `MACHINE_PROVISIONING=external` (ADR 0065 §5): every workspace there gets a computer of its own, and no other computer joins it.
  - Serving more organizations is a later, explicit choice.
- In an organization it serves, the row is created with the organization, so onboarding's computer step lists it first (selected once it's connected: a computer that never comes up would leave agents waiting), and the runner picks up its token at the next sync (60 seconds).
- When a row gets its first token (new, or turned back on), the organization's agents with no computer start using it, unless the server has cloud computers. New agents start on it.
- Admins turn it off per organization ("Parar de usar nesta organização" soft-deletes the row) and back on.

**Guards:**

- The runner's state (`/var/lib/agentes-runner`) and the native `~/.agentes` are secret folders for agents' reads, like `~/.agentes-runner`. They hold every organization's machine token, and natively the database.
- Files any computer uploads go to the server it's paired with, at the path the server gave. `PUBLIC_URL` may not be reachable from the host itself (a tailnet name served from a container).
- The token of the runner's `--token-env` is taken out of its environment, so neither the children nor the agents' commands see it.

The Cloud never sets `HOST_COMPUTER_TOKEN`: each Cloud workspace has a machine of its own (`kind = 'managed'`).

### 4. Plain words about computers

The onboarding, preparing and computer screens never name the system (Linux, Debian, Ubuntu), an address (IP), virtual CPUs, or the tools installed (Chrome, git, Node, Python, Rust, Docker, kernel). Sizes ("4 CPUs · 8 GB de memória · 75 GB de disco") and "um usuário para cada agente" stay.

- A computer's internet address appears only under an "Avançado" section of its page that only admins see, because firewall allow-lists need it.
- `packages/i18n/test/plain-computer-copy.test.ts` checks every string under `onboarding.computer.*`, `computer.*` and `machine.*` in both languages. A new screen about computers adds its namespace there.
- The steps for connecting your own server (Settings → Computadores) still say "Linux": that person needs it.

### 5. The usage report

A self-hosted server sends agentes.chat an anonymous usage report about an hour after it first starts and then once a day. It is on by default, and whoever runs the server can turn it off. agentes.chat's own servers always send theirs.

- **Counts and sizes, never content.** A random id made at the first start; the version, edition, install mode (`docker`, `native`, `desktop`: `INSTALL_MODE`, else a container means `docker`), system and uptime; the host's size and load; organizations, people and people active in the last 1, 7 and 30 days; agents; the computers seen in the last 30 days, one line per kind, system and size with how many are alike, their agents and their combined load (the 50 largest lines); and for the last day, runs, tool calls, minutes of desktops watched or controlled and of terminals, and per provider and model the calls and input and output tokens, from the usage records every model call writes (the 50 most used). Never messages, files, names, emails, hostnames, paths, prompts, IP addresses, or ids of organizations, people or computers; a model outside the model catalog (`catalogModelOf`: a typed name, a deployment, a fine-tune or an ARN can name a company or carry an account id) goes as `other`. Both caps keep a report well under the 32 KB the receiver takes. `SELF_HOSTING.md` lists every field.
- **Sizes and load.** Self-hosters run anything from 2 CPUs and 4 GB up, so every machine says how big it is and how busy it gets. The host: the whole machine's logical CPUs (`os.cpus()`) and memory, the disk holding the files (`FILES_DIR`, else the working folder) and whether it runs in a container, rounded; in a container with limits, `limit` adds what the process may use (`availableParallelism()`, `process.constrainedMemory()`), since the load average and the memory figures stay the whole machine's. Load: the 5-minute load average per logical CPU of the machine and the share of its memory in use (`MemAvailable` on Linux, `vm_stat` on macOS, run without blocking the server; the page cache counts as free), sampled every 5 minutes, then the average and the highest over the last day. The server keeps its host's summary and the samples behind it in its own database row (`instance_telemetry`), so the report printed elsewhere has it and a restart keeps the day.
- **Computers (machine protocol 22).** The runner's `hello` carries `size` (its workspace's disk, and `limit` as above), and its next `pong` after each sample carries the last day's `load`; both are stored on the machine. Nothing new goes to the runner, so an older one sends neither and its computer is reported with its size unknown. A provisioned computer that hasn't said falls back to the provisioner's size (`machine_provisioning.specs`). The server's own computer has a row per organization it serves and counts once. A load older than a day is left out.
- **Turning it off.** `TELEMETRY=off` in the server's settings, or the switch in Settings → General, which only the installation's first account sees (stored in the database). `TELEMETRY=off` wins, and the card says so. A development server (`NODE_ENV` not `production`) never sends. On agentes.chat's own servers (`PUBLIC_URL` on agentes.chat) it is always on and nobody has the switch: there, the first account is a customer.
- **Sending.** The JSON in a POST to `TELEMETRY_URL`, with a 10-second timeout. The due time is kept in the row (`next_report_at`): a restart waits out the rest of the day, a report that came due while the server was off goes 10 minutes after it starts again, and the first one comes an hour after the first start even across short runs (the desktop app). A failed send is tried again after 5 minutes, 30 minutes and 2 hours, then the next day's report takes its place: nothing queues up. Failures go only to the debug log; nobody sees them and nothing waits on them.
- **`TELEMETRY` is read when the server starts.** Whatever writes it (the wizard, the desktop app) restarts the server, or turns a running one off with the owner's switch (`PUT /api/app/telemetry`).
- **The wizard** asks one yes/no question with one plain line saying what it is, and never prints the report. `agentes telemetry` (through the image, `docker compose run --rm agentes telemetry`) prints exactly the next report, on or off, and sends nothing.
- **Settings** shows a card with its title, the switch and "Ver o que é enviado" (the next report, as is), and a line only when `TELEMETRY=off` holds it off.
- **Copy** says what is sent, never why: "Send anonymous usage statistics to agentes.chat: counts such as people, agents, machine sizes and AI tokens used. Never messages, files or names."

The terminal and the card stay short, and the full explanation lives in one public place.

## Consequences

- One line installs agentes.chat on a Linux server, or a Mac with Docker; with native mode, on a Mac without Docker too. With the server's computer, agents have a computer from the first minute.
- Two database engines in production: every migration must also run on PGlite (the tests already do), and a PGlite upgrade across a Postgres major needs the dump-and-restore path.
- On Linux, the server's computer runs agents' commands on the host. Their isolation is the system mode's OS users, not a container.
- The server's computer holds the agents of every organization it serves, and so of different people, on one machine. Until the system mode's loopback guard checks each connection when it starts (it scans for ports every 2 seconds), local ports there are not a hard boundary between agents.
- The first install is longer: the agent browser and the command-line tools come with the computer.
- The installer needs `@agenteschat/setup` on npm; until then, `AGENTES_INSTALL_SETUP` and locally built images are how it's tested.

## Alternatives considered

- **`npx @agenteschat/setup` as the one command:** needs Node.js, which many servers and Macs don't have.
- **A container as the server's computer:** Chrome's sandbox needs seccomp and AppArmor exceptions there, and per-agent users, slices and desktops don't fit in it.
- **Embedded Postgres binaries, Homebrew or Postgres.app for native mode:** no pgvector, or one more install.
- **The server's computer for every organization, with the server refusing to start while sign-up is open:** invitations and creating an organization still let other people's agents onto the operator's machine.
