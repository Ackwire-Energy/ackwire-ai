# 0036. Desktop app: Tauri in the menu bar, the runner as its child process

- Status: Accepted (not built yet)
- Date: 2026-10-17
- Planning: D51
- Extends: ADR 0025 (connected computers), ADR 0029 (missions and background tasks), ADR 0030 (isolation), ADR 0035 (shared client packages)
- Prototype: `docs/design/telas/AppBandeja.html` (awaiting approval)

## Context

A computer joins an organization through `agentes-runner`, a JavaScript file run by Node 22+ or Bun. It is installed with a shell one-liner, paired with a code created on the site, and kept alive as an OS service (launchd, systemd user unit, Task Scheduler). Settings live in `~/.agentes-runner/config.json` and are edited by hand. `agentes-runner update` downloads the latest `.mjs` from our server.

That works for developers and servers. It does not work for the people the product is for (teams in general, not only developers): they don't have Node, don't open a terminal, can't see what the agents are doing on their computer, can't pause them, and have no place to grant access. "Permissions only widen on the machine" (machine folder access, `PastasComputador.html`) currently means "copy this command into a terminal".

## Decision

### 1. A Tauri 2 app in `apps/desktop`, living in the menu bar / tray

- Tauri 2 shell with a React + Vite web view. The UI imports `@agenteschat/ui` (components, the agent engine, the sky), `@agenteschat/i18n`, the tokens (`tokens.css`) and, when it talks to the server, `@agenteschat/client`. Same rules as the web: no DOM-free constraint, no `ee/` imports, no keys in the client.
- Not React Native for desktop: `react-native-macos`/`-windows` are not Expo, lack the modules the phone app uses (blur, SecureStore, notifications), have weak tray support and no Linux, and would not reuse the DOM design system. Not Electron: the runner as a child process gives us what an in-process Node would, at a tenth of the size and memory for an app that is always open.
- The app is a tray icon plus small windows: the popover (now, pause, open site, preferences, quit), first run, Preferences (General, Folders, Tools, Updates, Activity, Advanced). The UI never says "runner", "MCP" or "protocol"; the app is called "agentes".
- Rust stays thin: tray and window positioning, spawning the runner, single instance, autostart, updater, native dialogs and notifications. Product logic lives in the runner (TypeScript) so the CLI gets it too.

### 2. The runner is the same code, compiled, and run as the app's child process

- CI compiles `apps/server/runner` with `bun build --compile` into one binary per target (first `aarch64-apple-darwin` and `x86_64-apple-darwin`) and ships it inside the app as a Tauri sidecar. People need no Node or Bun.
- **Desktop mode has no OS service.** The app starts at login (Tauri autostart) and spawns the runner; quitting the app stops it. If the runner exits unexpectedly the app restarts it with backoff (1 s, 2 s, 4 s… capped at 60 s) and shows the state in the tray.
- Background tasks and missions are unaffected: they already run detached under a wrapper and survive runner restarts (ADR 0029), and Claude Code resumes with `--resume`.
- Accepted trade-off: with the app closed, agents can't use the computer. The Quit dialog says so.
- **Headless mode is unchanged**: the shell installer, Node/Bun and the OS service stay for servers and people who prefer the terminal.
- Paths that pointed at "runtime + script" (the service definition, the `agentes-runner mcp` command written into Claude Code's MCP config) resolve to the compiled binary when there is no separate runtime (`process.execPath === script`).

### 3. App ↔ runner: stdio for live state, the config file for settings

- The app spawns `agentes-runner app`. In this mode stdout carries only JSON lines of a small control protocol; logs go to `~/.agentes-runner/logs/` (rotated). Only the parent can talk to it: no socket, no port, nothing another process can reach.
- Requests (app → runner) and replies/events (runner → app), each with an `id` for replies:
  - `status` → paired, server, org, machine name, connection state, versions, executors (Claude Code / Codex with login), pause state.
  - `jobs` and live `job.started` / `job.finished` events (agent, short summary, folder, command if any).
  - `pause { until | null }`, `resume`.
  - `activity { before?, limit, agent? }`.
  - `config.get` / `config.set` for the non-secret fields (name, limits, workspace). The token is never sent over the channel.
  - `pair.start` / `pair.cancel` (section 5), `unpair`.
  - `diagnostics` → a redacted bundle (versions, OS, recent log lines with secrets removed).
  - v0.2: `folders.*`, `tools.*` and the `access.requested` event (section 8).
- **The config file stays the single source of settings.** The runner watches `config.json` and reloads on change, so `agentes-runner` commands in a terminal and the app edit the same thing. Writes stay atomic with mode 600.
- The protocol has its own version in `hello` between app and runner; the app refuses a runner it doesn't understand (can't happen when both ship together, but guards development builds).

### 4. Single instance and adopting a terminal install

- One runner per OS user and runner home: a lock file (`~/.agentes-runner/runner.lock` with PID, checked for liveness) taken by `start` and `app`. A second one exits with a clear message. Tauri's single-instance plugin keeps one app.
- On first launch the app looks for an existing install: a `config.json` and/or the OS service. If found, it stops and uninstalls the service, keeps the config (pairing, workspace, limits), marks `"managedBy": "desktop"` and starts its own runner. Nothing is re-paired.
- With `managedBy: "desktop"`, `agentes-runner update` and `service install` from a terminal refuse and point to the app, so the two install modes can't fight.

### 4b. More than one organization on one computer

- A computer can join several organizations, and several agents of each can use it (agents already get one folder each).
- **One runner per organization**, each with its own home and workspace: `~/.agentes-runner/orgs/<orgId>/` (config, token, lock, tasks, logs, activity) and `~/agentes/<org-slug>/` (agent folders). The app spawns one child per organization and shows them grouped in the popover. Today's runner code works unchanged per home (`AGENTES_RUNNER_HOME`).
- Why not one process with several connections: separate processes keep one organization's ops, tasks and tokens out of another's memory and journal, and need no refactor of the runner.
- "Adicionar organização" in the popover and in Preferences runs the same sign-in (section 5) into a new home. Leaving one organization stops and removes only its home (agent folders stay on disk).
- Adopting a terminal install moves the existing single home into `orgs/<orgId>/`.
- Honest limit: file tools keep each organization in its own folders, but commands run as the same OS user and can reach the other organization's folders (ADR 0030). Protected mode (ADR 0030 level 2) closes that; until then the Tools tab says so.
- Limits (background tasks, Claude Code processes) apply per organization in v0.1. A computer-wide cap comes later if several organizations compete for the same machine.

### 5. Signing in from the app (device code, started by the computer)

Today the code is created on the site and typed into the computer. The app reverses it, like OAuth's device flow; the runner drives it so the CLI can use it too (`agentes-runner pair --browser`).

- `POST /api/machines/device` (no session, rate limited per IP): returns `deviceCode` (secret, 32 bytes), `userCode` (6 characters, unambiguous alphabet, shown as `K7Q·4ZP`), `verificationUrl` (`<PUBLIC_URL>/conectar?code=K7Q4ZP`), `expiresIn` 600, `interval` 3.
- The app opens the URL. The page (signed in, or after sign-in) shows the code, the computer's name and OS, and the organization picker; "Conectar" confirms. Only people allowed to connect computers in that org (as today's pairing) can confirm.
- `POST /api/machines/device/token { deviceCode }`: `authorization_pending` until confirmed, then the machine token once (same `agm_…` token and machine row as today's pairing), then `expired_token`. Polling faster than `interval` gets `slow_down`.
- The token goes straight into the runner's config; the web view never sees it.
- **Against a link sent by someone else** (the classic device-code phishing: an attacker starts the flow on their own computer and sends you the link): the code lasts 10 minutes and works once; the page shows the computer's name, OS and approximate location, and says "Só confirme se você acabou de abrir isso no seu computador"; the new computer is announced in the org (notification to admins) and can be disconnected at once; and **a new computer gets no agents**: an admin or an agent's owner has to point an agent at it (`setAgentComputerTarget`), so a rogue computer receives no work and no secrets.

### 6. Pause

- `pause { until }` sets a runner state (`paused`, `until`), persisted so a restart keeps it, and the runner reports it to the server (protocol 9: a `runner.state` message and the field in `hello`).
- The server treats a paused machine like an offline one for new work: new ops and new tasks are refused with `machine_paused` (with `until`), and the agent says in the chat that the owner paused the computer. Work already running finishes. Agents whose engine is this computer's Claude Code (D38) follow the choice already stored on the agent (`agents.brainFallback`): with fallback on they answer through the API model, with it off they say the computer is paused and wait. Nothing new to configure.
- The web shows "Pausado até 16:24" on the computer page.

### 7. Activity log

- Each runner appends to `activity.jsonl` in its home. When the file reaches 5 MB it becomes `activity.1.jsonl` and a new one starts; at most 3 files are kept (about 15 MB, weeks of normal use), the oldest is deleted. Each line holds: time, agent (id and display name, sent with each op from protocol 9), kind (file read/write, command, task, access change, update), a short summary, the command line with secrets redacted (ADR 0027), and the result (ok, failed, refused).
- Local only. The server keeps its own audit; this is what the person sees about their own computer.

### 8. Folders and tools (v0.2, separate ADR or an amendment)

The machine-side access model from `PastasComputador.html` (allowed folders, which agents use each, tools on/off, enforced in file tools, commands and Claude Code `--add-dir`) is built in the runner and exposed both as `agentes-runner folders|tools` and through the app. An agent missing access posts its request; the runner raises `access.requested`; the app shows a notification and the request in the popover; "Liberar" writes the config; the runner reports the new access and the agent continues. Granting never comes from the server.

### 9. Updates

- Tauri's updater with our own signing key (free, independent of Apple). The private key lives in GitHub secrets; the public key is built into the app. An update whose signature doesn't verify is refused.
- The app checks every 6 hours. It downloads in the background and installs when the runner reports no op or brain turn in progress (background tasks don't block: they survive the restart), or overnight, or when the person clicks "Instalar agora". "Atualizar sozinho" can be turned off.
- Since the runner ships inside the app, updating the app updates the runner. If the server ever requires a newer protocol than the runner has, the tray shows "Atualize para continuar" instead of failing silently.
- **Where updates live.** This repository's CI builds the binaries and publishes them as a GitHub Release here (private). The updater can't read a private release, so our server proxies it: `GET /api/desktop/update/{target}/{arch}/{current}` returns Tauri's manifest (204 when current) and `GET /api/desktop/download/{target}/{arch}/{version}` streams the asset, both reading the release with a fine-grained GitHub token (`DESKTOP_RELEASES_TOKEN`, read-only on this repo's contents). The download page links to the same route. The update signature is checked by the app, so the proxy can't alter what it serves.

### 10. Distribution without code signing (for now)

- macOS builds are ad-hoc signed only (required on Apple Silicon), not notarized. First launch needs System Settings → Privacy & Security → "Abrir mesmo assim"; the download page shows that step with a screenshot. Updates installed by the app don't carry the quarantine flag and don't ask again.
- Side effect: macOS may ask again for Documents/Desktop/Downloads access after an update, because the ad-hoc identity changes per build. Folders outside those (`~/agentes`, `~/Projects`) never ask. Revisit when we sign.
- Windows (later): SmartScreen's "Mais informações → Executar assim mesmo" until we sign.
- CI: `.github/workflows/desktop.yml`, manual or on a `desktop-v*` tag, on a macOS runner: compile the runner for both architectures, build a universal `.app` + `.dmg` with `tauri-action`, sign the update bundle, publish. Nothing runs on a developer's machine; testing means installing the CI build. The UI can be iterated in a browser against a fake runner (`apps/desktop/src/dev/fake-runner.ts`).

### 11. Security

- The machine token stays in `config.json` (mode 600, folder 700). The web view never receives it; Tauri capabilities allow only our sidecar, the updater, autostart, notifications, dialogs and opening our own URLs. No general filesystem or shell access from the web view.
- A click in the app is an action on the machine, so the rule "access only widens on the machine" holds. The server can show and reduce, never grant.
- The control channel exists only between the app and its child.
- The web view loads only the app's own bundle, with a strict CSP. It never loads agentes.chat or any remote page with access to the app's commands; the site opens in the person's browser.
- Without Apple notarization, the OS doesn't vouch for the first download: someone could pass around a fake "agentes". The app is downloaded only from agentes.chat over HTTPS, and the page shows the SHA-256 of each build. From then on, updates are verified by our own key.
- The updater private key is the one secret that could push code to every installed app. It lives only in GitHub secrets (with a passphrase); rotating it means shipping a release signed with the old key that trusts the new one.
- Not new, but now reachable by non-technical people: commands run as the person's OS user (ADR 0030). Safe defaults matter more: no extra folders, commands off, and Claude Code on only when found and chosen at first run.

### 12. Order

- **v0.1 (Mac):** compiled runner, `agentes-runner app` with the stdio protocol, lock file, adoption of terminal installs, device-code sign-in (server + `/conectar` page), pause (protocol 9), activity log, the app (tray, popover, first run, Preferences without Folders), autostart, updater (server proxy of the private release), several organizations, CI and a download entry in Settings → Computers.
- **v0.2:** folders and tools on the machine, access requests and notifications.
- **v0.3:** Windows and Linux (tray quirks, WebView2 visual QA, SmartScreen), then signing and notarization.

## Resolved in review (2026-10-17)

- Updates: built and released by this repository's CI (macOS only for now); served through our server because the repo is private (section 9). Notarization later.
- Several organizations and several agents per computer: yes (section 4b).
- Pause with brain-engine agents: the agent's existing fallback choice decides (section 6).

## Consequences

- People connect a computer without a terminal, see and pause what agents do there, and grant access with a click on the machine.
- The runner gains an app mode, a lock, config watching, pause and an activity log; all of it also serves the terminal install.
- Two install modes coexist (desktop-managed and service-managed), kept apart by `managedBy` and the lock.
- Unsigned builds add a one-time OS warning and possible repeated permission prompts on macOS until we sign.
- A Rust toolchain enters CI (macOS runner minutes cost more than Linux).
