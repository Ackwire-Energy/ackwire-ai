# 0066. One desktop app: agentes.chat, your own server, or a server here

- Status: Accepted. Built: the first run, the server list, links, agents here for your own server, Preferences by mode, Windows and Linux builds. Not built yet: running agentes.chat on this computer (§7).
- Date: 2026-10-25
- Supersedes: ADR 0036's menu-bar-first model, its "the runner ships and starts in every install", and §11's "the main window loads agentes.chat only"
- Extends: ADR 0025 (connected computers), ADR 0035 (phone app, connect links), ADR 0036 (desktop app), ADR 0060 (one-command install)

## Context

The desktop app began as a menu bar app that let agents use this Mac: its first run signed the Mac in with a device code, it always started the runner, and its main window loaded agentes.chat only. Two things changed. agentes.chat Cloud gives every workspace a computer of its own, always on, so the Cloud no longer uses people's computers. And self-hosting is entirely the person's own: their server, database, files, computers and AI accounts, with no agentes.chat account and no sign-in with us. People on both need one app that is first a good client, on macOS, Windows and Linux, and only on a self-hosted server also a computer for agents.

## Decision

### 1. One app, the Cloud first

- The first run (the welcome window) has one big action, "Sign in to agentes.chat" (with "Create an account"), and a small line under it, "Use your own server". Nothing on that screen loads agentes.chat: it is the app's own page, so a self-hoster's first run contacts us for nothing but the app's update check.
- "Use your own server" leads to Connect: an address (the same one the person opens in the browser), servers found on this computer or the person's Tailscale network, and, for a server that has none yet, "Don't have one yet? Run this on it" with the one-command install (ADR 0060) and Copy. On Windows it goes first to "Your own server", where "Run agentes.chat on this PC" explains the two ways for now (another computer, or WSL 2 with `--network local`, which the PC then finds on `localhost`).
- Connect follows ADR 0035's checks (`checkServer`: `GET /api/instance`, the server's own address when it differs). Plain http is accepted only for this computer's own loopback (`normalizeServer(…, { allowHttp: "loopback" })`); everything else stays https, so the app never sends a session over a network in the clear. There is no scan of the local network: servers listen on their own machine, and the tailnet and this computer are where they are found (`discover`: `~/.agentes/server.json`, ports 4310 and 3000, `tailscale status --json`'s `agentes.<tailnet>` and online devices named `agentes…`, at most 5).
- A server that waits for its first account through the setup's owner link (`ownerClaim` in `/api/instance`) is not entered: the app says to open the link the installer printed.

### 2. The servers this app opens

- Rust keeps a list and the current one (`servers.json` in the app's config folder). The main window loads the current server; switching keeps each server's sign-in, since cookies are per origin. The list is in Preferences › Servers (Open, Remove), in the menu bar's Servers menu on a Mac, and in the tray's menu on Windows and Linux.
- agentes.chat's pages get the capability in `capabilities/main.json`; any other server's get the same one, added at runtime for that origin only (`CapabilityBuilder::remote("<origin>/*")`, once per origin). Navigation rules are the same against whichever server is open: its pages stay, `/desktop/sign-in` goes to the browser, everything else opens outside.
- A page of a server in the list (an agent's browser request, an organization's page from the menu bar) opens in the main window, switching to that server. The only pages that open in the browser are the providers' sign-in pages and the app's own downloads.
- `window.__agentesDesktop` carries `platform` (`mac`, `windows`, `linux`): the site keeps room for a Mac's window buttons only there, and names this computer in its words ("Use this Mac", "Use this computer").

### 3. Links

- The app registers `agenteschat://`, the scheme the phone app and every QR code already use (`tauri-plugin-deep-link`; on Windows and Linux a link reaches the running app as a second launch, through the single-instance plugin's `deep-link` feature, and an AppImage registers the scheme at start).
- `agenteschat://connect?server=…[&token=…][&claim=…]` (`parseConnectLink`: a token or claim of 20 to 200 URL-safe characters, the whole link at most 2 KB, other parameters ignored) shows the server in large type, with a chip for Tailscale or this computer, and asks before anything changes: "Connect the app to this server?", with "You leave … in this app. Your account there stays." when another server is open. A link to the server already open just brings the window forward. A token ("Sign in to this server with your account from the other device?") opens `/desktop/handover#token=…`, which takes the token out of the address and the history at once and trades it at `POST /api/auth/sign-in/one-time-token` for a session of the window's own. A claim, while the server waits for its owner, opens `/owner#claim=…`. Anything else: "This link isn't from an agentes.chat server."
- A link never pairs this computer, starts a server or installs anything. One-time secrets travel only in a URL fragment, to their own server, and Rust passes on only `/login`, `/signup` or those two pages after a server's origin (`page_path`).

### 4. agentes.chat is a plain client

- With agentes.chat (or any server whose agents work elsewhere) nothing of this computer runs or shows: no runner starts (the app spawns runners only for homes on disk), no pairing, no folders or tools, no computer words. On a Mac the menu bar icon is off then (the Dock carries the badge); "Show in the menu bar" turns it on, and the app always keeps the Dock icon or the menu bar icon. Windows and Linux have no Dock and closing the window only hides it there, so the tray icon is always on, with a native menu (Linux's AppIndicator passes no clicks to the app); on Linux, where some desktops show no tray, closing the main window minimizes it.
- Preferences shows General, Servers and Updates; this computer's tabs (Folders, Tools, Activity, Advanced) only while agents work here.
- The site's notifications (mentions, direct messages, what waits for the person: what a phone gets pushed, ADR 0035 §4) show while the window is in the background (`this_mac` `notify`): at most one every 3 seconds and 60 an hour, title 80 and body 180 characters, a path of the same server, which opens if the person comes back within 30 seconds. "Let me know about messages and requests" turns them off.

### 5. Agents on this computer, for your own server

- Only for a server of the person's own, on macOS and Linux (`agentsHere`): never for agentes.chat (each workspace has a computer of its own), a server on this computer itself (its own computer is set up with it, ADR 0060 §3), or on Windows (no program for agents ships there yet). The site hides "This Mac" wherever the app says no; an app from before this answer allowed it everywhere.
- The way in stays the site's one click ("Use this Mac" in the onboarding and in Settings › Computers). Before any page pairs this computer, the system's own dialog asks: "Let agents of {org} work on this Mac? {host} asked. They start with no folders of yours and commands off; you choose more in Preferences." The host comes from the app (the page's own origin), the organization's name from the page (display only). Then the runner pairs with that page's own server and the site confirms the code with its own session; nobody reads a code.
- `this_mac` answers about the asking server's own homes only: Rust adds the page's origin and `agentsHere` to every request it relays, and refuses `connect` where `agentsHere` is false.
- A first organization starts with the browser on, Claude Code and Codex on when found here, and commands off; another one copies the tools the others have. "Reconnect this Mac" (an organization that refused it) opens that organization's Computers settings, where pairing again brings the same computer back (ADR 0036 §5).

### 6. Platforms and builds

| | agentes.chat | Your own server | Agents on this computer |
|---|---|---|---|
| macOS (universal, 11+) | yes | yes | yes |
| Windows (x64, NSIS) | yes | yes (https, or `localhost` for a server in WSL 2) | not yet: no runner ships |
| Linux (x64, AppImage and deb) | yes | yes | yes, as the person (the system mode with screens is the server install's, ADR 0057) |

- `desktop.yml` runs one job for the version, three builds (macOS universal, signed and notarized; Windows; Linux on Ubuntu 22.04 for an older glibc) and one publish job. `tauri.windows.conf.json` ships no runner and no agent-browser; `tauri.linux.conf.json` makes the AppImage and the deb, with the runner compiled for `bun-linux-x64-baseline`.
- The server's release reader learns the three targets (`desktopAssets`): Windows' installer is its own updater bundle; on Linux the deb is the download and the AppImage updates itself. A release without a platform's files leaves that platform on the newest release that has them. The release list is read once in 5 minutes for every platform.
- A self-hosted server has no builds of its own (no `DESKTOP_RELEASES_TOKEN`): its download button asks agentes.chat's public answer, without the page's cookie.

### 7. Not built yet: agentes.chat on this computer

"Run agentes.chat on this computer" (the native server inside the app, its owner key, this computer as the server's own computer, reach through Tailscale, the usage-statistics switch on by default) comes next, on this design: `RUN_HERE` (`control/first-run.ts`) turns its card on in "Your own server" on Mac and Linux, and the app's `agentsHere` then also says no for the server it runs itself.

### 8. Coming from the menu bar app

On the first start of an app that keeps a server list (no `servers.json` yet), Rust reads the homes before any runner starts: homes paired with agentes.chat stop and go (their agents' folders stay; one notification says where), homes of an own server keep running and their servers join the list (the first by organization name is the one open), and homes a terminal install's `agentes-runner host` keeps (`managedBy: "host"`, which share `~/.agentes-runner/orgs/`) are never started by the app. The menu bar app's "Server: … · Change" choice opens as the current server.

## Consequences

- The app is a client first: people on agentes.chat get the workspace without anything running on their computer, on three systems.
- Self-hosters connect by address, by what the app finds, or by the setup's link, and their server is the only one the app talks to besides our update check.
- A server the person connected to is a website with a narrow bridge: its own homes, a native dialog for every pairing, notifications within limits.
- Until the first three-platform release, the screens are checked in a browser with the fake host and the Rust in a Linux container; the macOS-only parts (the notch, the Dock, the menu bar) are compiled by the macOS build.
