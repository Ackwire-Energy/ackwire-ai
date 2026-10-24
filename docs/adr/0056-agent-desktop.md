# 0056. The agent's computer as a desktop people watch and control, and a terminal

- Status: Accepted (2026-10-24)
- Date: 2026-10-24
- Builds on: ADR 0025 (connected computers), ADR 0030 (isolation), ADR 0031 (computer use), ADR 0036 (switches on the machine), ADR 0040 (the agent browser and its handoffs), ADR 0054 (the screen layer computer use reuses)
- Changes: ADR 0031 §6 (on a connected Linux computer the virtual display is an Xtigervnc desktop per agent, §1) and §8 (a person drives a desktop over RFB, not frames and injected input, §5); ADR 0031 §10 and ADR 0030 level 3 (system mode gives each agent its own OS user, §10)
- Protocol: 18 (`DESKTOP_PROTOCOL` in `packages/adapters/src/machine-protocol.ts`)

## Context

People want to see everything an agent does on its computer, not only its browser, to take control at any moment, and to open a terminal on the agent's computer to run commands themselves. ADR 0040 covers the browser (its JPEG live view and its handoffs); ADR 0031 §6 planned one virtual display per agent on connected Linux computers. Self-hosters run this on their own Linux machine; the Cloud runs the same code on its machines.

### Measured (a 4-vCPU, 8 GB VPS; Debian 13, kernel 6.12, TigerVNC 1.15, XFCE 4.20, Bun 1.4.4)

| What | Result |
| --- | --- |
| Desktop start: Xvnc listening / desktop drawn | 0.2–0.3 s / 2.6–4.9 s |
| Memory (PSS) | Xvnc 42–68 MB, XFCE 108–120 MB (150–190 MB idle); with a headed Chromium and two tabs, about 780 MB |
| Stream open on the machine: connect and VncAuth / ready | 8–13 ms / 28–51 ms |
| Bandwidth per viewer at 1280×800 | idle 4 KB/s, typing 34 KB/s, a page load 300 KB/s, scrolling or video up to 2.3 MB/s; RFB's pull model adapts (110 KB/s on a 1.5 Mbit/s link, no backlog) |
| Quality 3 against 6 at 10 Mbit/s and 100 ms | twice the updates (37/s against 18/s) for the same bytes |
| Key to screen through the relay | median 35 ms at 0 RTT, 132 ms at 100 ms, 233 ms at 200 ms |
| CPU per viewer | Xvnc 0.7% of a core idle, 24–55% while the screen moves; the relay 3–4% |
| View-only by password | a pointer event on a view-only connection is ignored; on a full one it moves the pointer |
| PTY | `Bun.Terminal` exists from Bun 1.3.5; first output in 54–106 ms; a resize is seen by `tput`; 24–37 MB/s |
| Typing accents | keysyms dropped `ê` and `õ`; the clipboard and a paste delivered `Olá, ação: êõú ç — 日本` exactly |

### Alternatives considered

- **Xvfb + x11vnc**: two processes, and view-only is an option of the server, not a property of each connection.
- **Relaying frames, like the browser's live view**: no flow control of its own and more CPU on the machine.
- **Streams on the machine socket**: a busy screen would delay tool results and heartbeats.
- **A VNC gateway on the machine (websockify) or Guacamole/WebRTC**: an inbound port, or another server to run.

## Decision

### 1. One desktop per agent: Xtigervnc and XFCE, on demand

- One `Xtigervnc` per agent display (X server and VNC server in one process): `:N -geometry 1280x800 -depth 24 -rfbport -1 -rfbunixpath <session folder>/vnc.sock -rfbunixmode 0600 -SecurityTypes VncAuth -PasswordFile <file> -AlwaysShared -AcceptSetDesktopSize=0 -FrameRate=30 -UseBlacklist=0 -auth <Xauthority> -nolisten tcp -s 0`. Never `-ac` or `-nopw`.
- No TCP listener: a loopback port can be taken first by another agent's process, which would then show a fake screen to the people watching and read what the person in control types.
- `DESKTOP_SIZE` is 1280×800 (inside the screen layer's image limits, ADR 0054). Viewers scale it and never resize it.
- An XFCE session (`dbus-launch --exit-with-session xfce4-session`), restarted up to 3 times in 10 minutes. Its own ssh-agent is off (the session's settings, written once into its `HOME`): it daemonizes and would outlive every desktop. The packages go in with `--no-install-recommends` (otherwise a screen locker nobody can unlock, more daemons and eight folders in each home): `tigervnc-standalone-server xauth dbus-x11 xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings thunar xfce4-terminal adwaita-icon-theme elementary-xfce-icon-theme fonts-noto-core`.
- Started on demand: the agent uses its screen or its browser, or a person presses "Ligar". A viewer alone never starts it. Stopped after 15 minutes without a stream, the agent's use, an open handoff or a viewer of the browser card; the agent's Chrome on it closes with it.
- Desktops per machine: `max(1, floor((RAM − 2 GiB) / 800 MiB))`, 7 on 8 GB. Over it, `desktop_busy`.
- A runner restart leaves desktops running (`KillMode=process`, `setsid`): the new runner takes them back after checking each pid's command line.
- The session's `HOME` is `<agent folder>/.agentes/home` in single-user mode (XFCE's files stay out of the agent's work), the agent's own home in system mode.
- The session folder (the cookie and the socket) is `<runner home>/desktop/<id8>/` in single-user mode, since a socket's path has at most 107 bytes and an agent's folder can be deeper; in system mode `~/.agentes/desktop/` of the agent's own user. Each agent keeps its display (`:20` to `:69`, `slots.json`); a display another process holds is skipped.

### 2. Raw RFB relayed as bytes, one data socket per stream

noVNC in the web app ⇄ `wss /api/desktop` ⇄ the server ⇄ one data WebSocket the runner dials for that stream (`/api/machines/stream`) ⇄ the agent's Xtigervnc over its Unix socket. The server never parses RFB, and RFB's pull model is the flow control. A terminal takes the same path with xterm.js and `wss /api/terminal`. The server replica that holds the machine's socket holds its streams; a viewer on another replica gets 4503 until streams cross replicas.

### 3. VNC security ends on the machine

- The runner logs in to Xvnc with the view-only password for a watcher and the full one for the person in control, then offers the viewer security type None over our own authenticated channel. Xvnc enforces view-only itself.
- Two random 8-character passwords per desktop start; they never leave the machine. In system mode the password file is root's (`/run/agentes-desktop/<uid>/passwd`, `root:<agent group>` 0440, in a 0750 folder under a 0711 parent): Xvnc reads it on every connection, so an agent that could write it would swap the two passwords and turn its watchers into controllers.
- A 16-byte MIT cookie per display, written with `xauth … source -` (never in an argument), in a home only its user reads.
- `-UseBlacklist=0`: TigerVNC counts attempts, not failures, so a burst of reconnects after a deploy would lock everyone out; behind a 0600 socket the blacklist protects nothing.
- TigerVNC sends the clipboard only to connections allowed to cut text: watchers never get the controller's clipboard.

### 4. Who may watch, take control and open a terminal

- **Watch**: the browser's rule, `requireBrowserAccess(…, "desktop")`: admins, the agent's owner, the person a request went to, and whoever is behind the agent's live work.
- **Control and the terminal** are one rule, because a desktop in control has a terminal and "Run Program": who may run commands as the OS user the desktop runs as.
  - System mode (each agent its own OS user): org admins and the agent's owner.
  - Single-user mode (the runner's own OS user, which holds every agent's folder, every account folder of ADR 0041 and the machine's token): only the person who paired the computer. The machine switch is no boundary there, since the agent's own code runs as that user too.
  - A computer nobody paired (a server's own computer): nobody, until it runs system mode.
  - The server applies the rule from the mode the runner reports in `hello`; a runner that reports none is single-user.
- `desktop_ask_person` asks only people who pass that rule: the agent's owner, else admins.
- Access is checked again every 30 s on open streams.
- In control or in the terminal a person can do whatever that OS user can do: that is the point, and why the rule is narrow. X11 has no input isolation: while a person is in control, any process of that user with the cookie (the agent's tasks, a brain's shell) can read the screen and the keys. The take-control text says so.

### 5. Control is a handoff on the `desktop` screen

- ADR 0040 §6's handoffs, kept per screen (`browser_handoffs.screen`): one person in control per screen; the other viewers' streams close with 4409 ("Ana está no controle · tela oculta"); "Devolver" with a note tells the agent who had control, for how long and the note, and the agent must look again (`desktop_read`); control is kept 2 minutes after the controller's view drops.
- A handoff stays on the screen it was asked for: the phone app keeps answering the browser's requests ("log in for me") over CDP, which drives a headed Chrome as well.
- An agent whose Chrome runs on its desktop shows the same window on both screens: an open handoff on either blocks a take over of the other and the agent's tools on both, and hides both views (the browser card's frames and the desktop's streams).
- The agent's running brain turns and tasks go on; its screen and browser tools wait (with §4's limit on input).
- When control starts, the desktop's keyboard layout becomes the controller's (`setxkbmap` as the agent): noVNC sends key codes, and the desktop's layout turns them into characters.

### 6. The terminal

- A `Bun.Terminal` PTY with the login shell as the agent's OS user, never root (system mode: `systemd-run --scope --slice=agents-<uid>.slice -- runuser -u ag-<id8> -- bash -l`). Its folder is the agent's; its environment has none of the agent's secrets and `TERM=xterm-256color`.
- A resize is a text frame. Output beyond a 1 MB backlog is dropped, followed by `[output skipped: too fast]` (`Bun.Terminal` can't pause).
- Closed after 30 idle minutes, and after 12 hours at most. No history is kept, and reconnecting opens a new shell: nobody types into a shell they didn't see start.

### 7. The agent's browser on its desktop

- For an agent with `desktop:use` on a computer that serves desktops, the runner's Chrome runs headed on the agent's display (`--start-maximized`; `--test-type` hides the bar the automation flag shows; `DISPLAY` and `XAUTHORITY`). `agent-browser` still attaches over CDP, on an OS-assigned port.
- The request says so (`desktop: true` on the agent's `browser.*` requests), which also covers a mission's computer.
- Chrome never restarts in the other mode while a handoff is open or someone watches.
- Its viewport is smaller than headless (about 686 px tall under the panel): ADR 0054's numbers are measured again headed.

### 8. The scope: `desktop:use`, always together with `sandbox:run`

- One built-in scope, `desktop:use`: outside "all tools" (`NOT_IN_ALL`), on by default for new agents (`DEFAULT_AGENT_SCOPES`), revocable by admins and the agent's owner. Desktop computer use (the agent's own tools on this desktop) uses it and adds no scope of its own.
- Driving a desktop runs commands as the agent's user, on any site (a terminal window, "Open Terminal Here"). So the desktop's tools are offered, and allowed on each call, only while the agent also has `sandbox:run`, the org's sandbox setting allows it, and the machine has both its `commands` and its `desktop` switches on.
- Migration 0092 grants `desktop:use` to the live agents that already have both `browser:use` and `sandbox:run`, and to no other.
- Routines (ADR 0053): its own internal area, `desktop`, allowed in routines that act and refused in read-only routines and unattended runs. `desktop_ask_person` speaks in the run's own conversation, like `browser_ask_person`.

### 9. Switches and availability

- Two machine switches, `access.tools.desktop` and `access.tools.terminal`, turned on at the machine (`agentes-runner tools enable desktop terminal`): off by default on a personal computer, on in the Cloud. The server can only turn them off.
- `hello.desktop` and `hello.terminal` say whether the runner can serve them, and why not: Linux, the runner on Bun 1.3.5 or newer (`Bun.Terminal`), and for the desktop the packages above. A runner on Node says so with the fix. Mac and Windows get no virtual desktop (the browser stays headless with its own live view); a Mac command-line runner on Bun 1.3.5 or newer serves the terminal.
- A paused computer (ADR 0036 §6) still shows a desktop that runs; starting one, taking control and a terminal are new work and wait for the resume (`isNewWork`).

### 10. OS users: single-user and system mode

- **Single-user** (the self-host default): the runner's OS user runs every agent, its desktop and terminal included (ADR 0030 level 1); the docs say so.
- **System mode** (`install.sh --system` on Linux; the Cloud): a root supervisor and one unprivileged worker per agent, as the agent's own user `ag-<id8>` (uid 20000–29999 by default), in `agents-<uid>.slice` with memory, task and CPU limits sized for a desktop, a headed Chrome and one CLI (about 1.5 GB).
  - Everything done for an agent runs as that user: commands, tasks, brains, files, its browser, its desktop, its terminal. The supervisor runs no agent code: until a worker serves an agent's requests, the root runner refuses them. Workers start on an agent's first request.
  - The runner is updated by its installer, never by itself.
  - Chrome's debugging port and `agent-browser`'s stream port have no authentication of their own: an nftables table, `inet agentes_runner`, lets only the owning agent's uid and root reach them, through port and uid sets the supervisor fills after checking who listens.
  - Chrome's sandbox needs unprivileged user namespaces (on by default in Debian 13): hardening must keep them.

### 11. Protocol 18

```ts
DESKTOP_SIZE = { width: 1280, height: 800 }
RunnerInfo (hello): desktop?: { available; reason?; width?; height? }; terminal?: { available; reason? }
RunnerTools (switches, absent = off): desktop?: boolean; terminal?: boolean
MachineRequest (each carries `agent`):
  { op: "desktop.session.start" }    // idempotent: starts it, or only marks it used
  { op: "desktop.session.stop" }
  { op: "desktop.session.status" }
  { op: "stream.open"; streamId; kind: "desktop"; mode: "watch" | "control" }
  { op: "stream.open"; streamId; kind: "terminal"; cols; rows }
MachineReplies:
  "desktop.session.start": { display; width; height; startedAt; started }
  "desktop.session.stop": { stopped }
  "desktop.session.status": { running; startedAt?; lastUsedAt?; streams }
  "stream.open": { opened: true }    // once the data socket got `stream.ready`
MachineErrorCode += desktop_unavailable | desktop_off | desktop_busy | terminal_unavailable | too_many_streams
```

- **Data socket** (runner → server): `GET /api/machines/stream` as a WebSocket; a request with an `Origin` is refused. The first text frame, within 10 s: `{"type":"stream.hello","token":"agm_…","streamId":"<43 base64url>"}` (the machine's token, which every runner process that opens streams holds, and the 32 random bytes of `stream.open`). The server answers `{"type":"stream.ready"}` or closes: 4400 not a hello, 4401 a bad token or another machine's stream, 4404 an unknown stream (ended, or served already), 4408 too late. Then binary frames are the bytes and text frames are control (`parseStreamControl`): `{"type":"resize","cols","rows"}` towards the terminal, `{"type":"exit","code"}` back. Both sides ping every 30 s. The runner answers `stream.open` only once it got `stream.ready`; when the data socket closes, the viewer's closes too (1000 when the runner closed it so, else 4503). The runner closes it with 1000 when the stream is over for good (the shell ended, after its `exit` frame; a viewer that broke the RFB handshake), and with another code when the viewer should open it again: 1011 when the desktop went away (the next open learns whether it still runs), 1001 when the runner's connection ended.
- **Viewer sockets** (web → server): `GET /api/desktop?orgId&agentId&mode=watch|control` and `GET /api/terminal?orgId&agentId&cols&rows`. Before the upgrade, like `/api/ws`: 401 without a session, 403 for a foreign `Origin` or a non-member, 400 for bad parameters. After it, close codes the panel turns into states (`STREAM_CLOSE`): 4400 bad request (a frame too big, too fast, or not the stream's) · 4403 forbidden, or access lost · 4404 no such agent, no computer, or an agent without `desktop:use` · 4408 the computer didn't open the stream in time (retry) · 4409 hidden (someone else is in control) · 4410 control ended, or never this person's (open again as a watcher) · 4429 too many streams, or too many opens · 4502 the computer refused (the reason is the error code, or `machine_paused`, `runner_outdated`, `not_allowed` for a switch that is off, `desktop_unavailable`, `terminal_unavailable`) · 4503 the computer is offline or on another replica (retry) · 1013 too slow · 1001 the server restarts (retry). What a viewer sends before its stream is ready waits for it (up to 1 MB).
- **REST** (`/api/app`): `GET …/agents/{agentId}/desktop` (availability, running, who controls, viewers, what this person may do, and the terminal's availability) and `POST …/desktop/start`; the screens' routes `…/desktop/handoff`, `…/desktop/takeover`, `…/desktop/stop`.
- **Limits** (`STREAM_LIMITS`): 4 viewers per desktop; 3 terminals per agent and 10 per machine; 30 stream opens a minute per person; a viewer's backlog 8 MB and the runner's 4 MB; a viewer's frames up to 1 MB and 512 KB/s; a terminal's size 20–400 × 5–200.
- **VncAuth** (test vectors): DES-ECB of the 16-byte challenge with the password as the key, each key byte's bits reversed: `password` and `00…0f` give `b866924125c8eebb9debc1db61c538e2`. TigerVNC's password file is each password encrypted with VNC's fixed key, bit-reversed `e84ad660c4721ae0` (`password` → `dbd83cfd727a1458`): the full password first, the view-only one second.

### 12. Audit, nothing stored

Handoff rows record control. `audit_log` rows `desktop.watched`, `desktop.controlled` and `terminal.session` keep the machine, the seconds and the bytes. No frames, keys or terminal output are stored, and nothing is recorded (ADR 0040 §8).

### 13. In the app

- On the agent's page, "Tela" (the live screen; watch, take control, "Devolver") and "Terminal" (admins and the owner), opened by `?desktop=1` and `?terminal=1`; "Ver a tela inteira" on the browser card. noVNC 1.7.0 (ES modules) and `@xterm/xterm` 6.
- Watchers ask quality 3, the person in control 6.
- "Colar texto" puts the text in the desktop's clipboard and pastes it (Ctrl+Shift+V in a terminal window): typed keysyms lose some accents. The person's own clipboard is never written from the desktop (a "Copiar" button instead).
- The phone app keeps the browser card and says the screen opens on a computer.

## Order

1. This ADR, protocol 18, the switches and the scope.
2. The server's stream broker and endpoints; the runner's desktop sessions.
3. The runner's data sockets and RFB proxy; the terminal.
4. Taking control and the desktop's REST; the agent's browser on its desktop.
5. The web panels; the self-host docs.
6. System mode: the install and its service, agent users and the launcher, per-agent workers, the loopback guard.
7. End to end on a real Linux machine, in single-user and in system mode.

## Consequences

- People see everything an agent does on its computer and can take over any app, not only the browser; desktop computer use builds on the same session and scope.
- A person in control, or in a terminal, acts as that computer's user: on a personal computer only the person who paired it gets that.
- Screens need Linux and Bun 1.3.5 or newer on the runner; runners on Node and Mac or Windows desktops keep the browser only.
- About 0.2 GB per idle desktop and 0.8 GB with Chrome: idle desktops stop after 15 minutes, and a machine caps how many run at once.
- Every viewer is a stream through the server, up to about 2.3 MB/s each way while the screen moves: the server's bandwidth is what to watch, and screens need a single server replica for now.
- Agents share one OS user in single-user mode, as before; separation between agents is system mode.
