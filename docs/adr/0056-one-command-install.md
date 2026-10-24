# 0056. One-command install, native mode, and the server's computer

- Status: Accepted (2026-10-24; to build, except the plain-words test)
- Date: 2026-10-24
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
- **Flags:** `--docker` / `--native`, `--dir`, `--yes`, and `--plan` (or `--dry-run`), which prints each decision and the commands it would run and runs nothing (what the tests assert). Every other flag goes to the wizard; with its `--json`, the installer's own lines go to stderr. `AGENTES_INSTALL_SETUP` points at a local build of the wizard. A version is held the compose file's way, with `AGENTES_IMAGE` in `.env`.
- **Folders:** `/opt/agentes` as root, `~/agentes` for a user who can already use Docker, `~/.agentes` in native mode.
- The docs also show "download, read, then run".

### 2. Docker or native

- **Linux:** Docker and Postgres (the compose file).
- **macOS:** Docker when an engine answers within 5 seconds (Docker Desktop, OrbStack, Colima). When Docker is installed but doesn't answer, it says "start Docker, or pass `--native`", because moving from native to Docker later is a dump and restore. With no Docker at all it goes native and says why.
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

The machine that runs agentes.chat is also a computer for its agents, "Computador deste servidor". It's on by default: the wizard asks, saying what it adds, and `--computer no` skips it.

- **Linux:** the runner is installed on the host in its system mode: a root supervisor that runs no agent code, and each agent as its own OS user with its own folder and memory limit. A container isn't used, because Chrome's sandbox doesn't start in a container with dropped capabilities and the default seccomp and AppArmor profiles, `--no-sandbox` next to every organization's tokens is not acceptable, and a container can't hold one OS user and one desktop per agent.
- **macOS:** the runner on the Mac. Agents run as the person there, so their commands stay off until the person says yes ("they run as you and can reach this server's files"). A dedicated macOS user is the safer yes (ADR 0030).

**How it joins organizations:**

- `HOST_COMPUTER_TOKEN` (generated by the wizard, at least 32 characters) is given only to the runner. It's compared with `safeEqual`, never logged and never sent to browsers.
- The runner calls `POST /api/machines/host/sync` (no session, rate limited). The answer has one machine row per organization, with `machines.kind = 'host'` (the values are `connected`, `host` and `managed`). Each row has its own ordinary machine token, stored as a SHA-256.
- The runner keeps one runner home and one child runner per organization (as the desktop app does, ADR 0036). Each child speaks the normal protocol, so outages, accounts and brains work unchanged.
- A row with no token gets a new one at the next sync (after it's turned back on, say), and changing `HOST_COMPUTER_TOKEN` clears every row's token.

**Which organizations it serves:**

- Only organizations where the installation's first account (the person who set it up) is an owner or an admin. Its rows are paired by that account.
  - So that person is the computer's owner for ADR 0041: they add the Claude and ChatGPT sign-ins on it, and pick them per agent.
  - Someone who joins through an invitation and then creates an organization of their own doesn't get agents on the operator's machine, so no sign-up rule is needed for it.
  - Serving more organizations is a later, explicit choice.
- In an organization it serves, the row is created with the organization, so onboarding's computer step lists it first and selected, and the runner picks up its token at the next sync (60 seconds).
- New agents with no computer use it.
- Admins turn it off per organization ("Parar de usar nesta organização" soft-deletes the row) and back on.

**Guards:**

- The runner's state (`/var/lib/agentes-runner`) and the native `~/.agentes` are secret folders for agents' reads, like `~/.agentes-runner`. They hold every organization's machine token, and natively the database.
- Files a computer uploads go to the runner's own `--server` address. `PUBLIC_URL` may not be reachable from the host itself (a tailnet name served from a container).

The Cloud never sets `HOST_COMPUTER_TOKEN`: each Cloud workspace has a machine of its own (`kind = 'managed'`).

### 4. Plain words about computers

The onboarding, preparing and computer screens never name the system (Linux, Debian, Ubuntu), an address (IP), virtual CPUs, or the tools installed (Chrome, git, Node, Python, Rust, Docker, kernel). Sizes ("4 CPUs · 8 GB de memória · 75 GB de disco") and "um usuário para cada agente" stay.

- A computer's internet address appears only under an "Avançado" section of its page that only admins see, because firewall allow-lists need it.
- `packages/i18n/test/plain-computer-copy.test.ts` checks every string under `onboarding.computer.*`, `computer.*` and `machine.*` in both languages. A new screen about computers adds its namespace there.
- The steps for connecting your own server (Settings → Computadores) still say "Linux": that person needs it.

### 5. A usage report, if one is added

An instance sends agentes.chat nothing on its own. If a usage report is added:

- The wizard asks one yes/no question with one plain line saying what it is, and never prints the report. `agentes telemetry` prints it on request.
- Settings shows a card with its title, the switch and "Ver o que é enviado", and nothing else.
- Before a release sends it, `SELF_HOSTING.md` ("Optional services and what they receive") lists what it sends and how to turn it off.

The terminal and the card stay short, and the full explanation lives in one public place.

## Consequences

- One line installs agentes.chat on a laptop, a server or a Mac mini, and agents have a computer from the first minute.
- Two database engines in production: every migration must also run on PGlite (the tests already do), and a PGlite upgrade across a Postgres major needs the dump-and-restore path.
- On Linux, the server's computer runs agents' commands on the host. Their isolation is the system mode's OS users, not a container.
- The first install is longer: the agent browser and the command-line tools come with the computer.
- The installer needs `@agenteschat/setup` on npm; until then, `AGENTES_INSTALL_SETUP` and locally built images are how it's tested.

## Alternatives considered

- **`npx @agenteschat/setup` as the one command:** needs Node.js, which many servers and Macs don't have.
- **A container as the server's computer:** Chrome's sandbox needs seccomp and AppArmor exceptions there, and per-agent users, slices and desktops don't fit in it.
- **Embedded Postgres binaries, Homebrew or Postgres.app for native mode:** no pgvector, or one more install.
- **The server's computer for every organization, with the server refusing to start while sign-up is open:** invitations and creating an organization still let other people's agents onto the operator's machine.
