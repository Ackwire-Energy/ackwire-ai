# 0040. The agent browser on connected computers, built on `agent-browser`

- Status: Accepted (2026-10-19)
- Date: 2026-10-19. Revised 2026-10-21: an honest closed state and a first frame (§7), a person opening a site, facts in the hand back, the page hidden from others while a person is in control (§6), the browser always reachable from the agent (§9)
- First slice of: ADR 0031 (computer use). Where the two disagree, this ADR wins for the browser.
- Extends: ADR 0025 (connected computers), ADR 0027 (secrets), ADR 0032 (one engine, the runner MCP as a bridge), ADR 0036 (desktop app, access on the machine), ADR 0010 (realtime)
- Out of scope for now: Daytona computers, the simulator (Maestro, its own ADR), the virtual desktop, the owner's desktop, video streaming (H.264/WebRTC), DOM replay (rrweb), several server replicas, intent tools with Jev, protected mode (ADR 0030)

## Context

ADR 0031 plans four kinds of screen. The browser carries most of the value (web apps without an API, test logins, Stripe test checkouts, checking a UI the agent just built) at the least risk. We take it first, on connected computers only.

### `agent-browser`

ADR 0031 §4 planned to drive Chromium over CDP ourselves. A tool already does that for agents: **`agent-browser`** (Vercel Labs, Apache-2.0, `github.com/vercel-labs/agent-browser`).

- A native Rust CLI and daemon, one daemon per session, speaking CDP directly to an installed Chrome (or Chrome for Testing it downloads). No Node, no Playwright. About 20 MB per platform.
- `snapshot` returns the page's accessibility tree as text with refs (`button "Submit" [ref=e2]`); actions take a ref (`click @e2`, `fill @e3 "…"`); a click covered by another element fails with the covering element named. `wait --text/--url/--selector/--load`, tabs, frames, dialogs, upload, console, network, `screenshot` (`--if-changed`).
- Per session: `--session`, `--profile <dir>` (persistent: cookies, storage, cache survive restarts), `--allowed-domains` (also blocks sub-requests, WebSocket, beacons, WebRTC), `--content-boundaries`, `--max-output`, `--action-policy`, idle shutdown.
- A local WebSocket stream per session: JPEG frames with viewport metadata and URL changes out; `input_mouse`, `input_keyboard`, `input_touch` in; fps capped per client; newest frame wins.
- It calls no model (an optional `chat` command through Vercel's AI Gateway is not used). The page is text, so any model drives it, including models without image input.

### How others do it (checked 2026-10-19)

| Product | Live view | Take over |
|---|---|---|
| OpenMausBot (Apache-2.0) | Relays `agent-browser`'s JPEG stream; noVNC for full container/VPS computers | A person's "hold" pauses the agents and survives a dropped stream for a while, so the panel reconnects and carries on |
| OpenBot (CopilotKit, MIT) | Screenshot polling while watching; Chrome's CDP screencast (JPEG) over a WebSocket while a person drives, input back over CDP (after DevTools' `InputModel.ts` and Steel's casting handler) | Command mapped to Control, paste forwarded |
| Steel | Headful: WebRTC H.264 at 25 fps from the OS display. Headless: CDP screencast, called legacy | `interactive=true` on the viewer |
| Kernel | WebRTC adapted from neko, or noVNC. Fixed resolution and capped fps because 1080p dropped frames | Read/write by default; pauses recording while a person types sensitive data |
| Browser Use, Anchor, Hyperbrowser | An iframe with a live URL (a bearer token) | The iframe is interactive; the embedding app locks it |
| Cloudflare Browser Run | Live view URL | A formal handoff: `handoff(instructions, timeout)` → the person picks Done or Failed → `handoffComplete { success, reason }` → the script resumes |

Conclusions: headless browsers stream JPEG frames; video (WebRTC) appears only where a full display is captured. The two products closest to ours (OpenMausBot, OpenBot) use JPEG for the browser, and OpenMausBot uses `agent-browser`. Cloudflare's handoff is the clearest shape for "the agent needs a person".

Lessons from OpenMausBot's code (`server/browser-relay.ts`, `server/browser-live.ts`):

- The daemon runs one command per session at a time: a read waits behind the agent's command, and a timed-out command stays queued.
- Some commands relaunch a Chrome that died; check `stream_status` before reading.
- The stream's `input_keyboard` lacks virtual key codes and text for Enter/Tab; complete them with `agent-browser`'s own key resolver.

### Alternatives considered

- **Our own CDP code:** weeks of work `agent-browser` already did; kept as the fallback behind our tools.
- **Video (H.264 through ffmpeg's WHIP output to LiveKit or Cloudflare, or WebRTC):** lighter on the wire, but an extra binary, an experimental muxer, a media service (inbound UDP, which not every host offers) and players on web and phone. For a login of a few minutes, JPEG at 10–15 fps is close enough.
- **DOM replay (rrweb):** very light and sharp for watching, but logins live in cross-origin iframes (Stripe, Google, captchas), OAuth opens popups, assets load from the viewer's browser without the agent's cookies, and clicks on a replica are fragile. Not for take over.
- **A visible window on the computer for logins:** dropped; one path everywhere (the stream).

## Decision

### 1. `agent-browser` behind our own tools

- The runner drives `agent-browser` (pinned version) as a child process with `--json`. Agents never get the raw CLI or its MCP server: they get our tools, so Stop, the allowlist, secrets, handoff and caps hold whatever the brain.
- Our tools are the interface: if `agent-browser` changes course, our own CDP code replaces it under the same tools.
- Turned off on our side: its credential vault (secrets come from `request_secret`), importing auth from the owner's Chrome (`--auto-connect`, Chrome profile reuse), `chat`, plugins, its dashboard.

### 2. Shipping

- **Desktop app (macOS):** a second Tauri sidecar next to `agentes-runner` (`externalBin`). CI downloads the pinned release, checks its SHA-256, signs it with our Developer ID and notarizes it with the app. It updates with the app.
- **Terminal installs (servers, Linux, Windows):** the runner downloads the pinned release from GitHub on first use into `~/.agentes-runner/bin/` and runs it only when its SHA-256 matches the one pinned in the runner (integrity comes from the pin, not from where it is served). Machines that never use the browser download nothing.
- **Chrome:** always Chrome for Testing, installed by `agent-browser install` on first use, with progress on the machine page; never the person's own Chrome (its updater rewrites the app while we hold it open, and macOS blames our app). Linux without Chrome's libraries needs `install --with-deps` (sudo): the runner doesn't report the browser and the machine page shows the command.
- **Started by the runner, attached by `agent-browser` (`--cdp`):** the runner launches that Chrome itself (headless, `--remote-debugging-port=0`, the agent's profile, no `--enable-automation`, `--disable-blink-features=AutomationControlled`, a normal user agent for its version) and every command connects to it. Measured on a Mac (2026-10-19): a Chrome `agent-browser` launches carries the automation markers (`navigator.webdriver` true, "HeadlessChrome"), and Google's sign-in answered "this browser or app may not be secure" while its search went to /sorry ("unusual traffic"); the same Chrome started by the runner and attached reached the account check and the results. This doesn't make the browser invisible to sites' own rules: a CAPTCHA or a "verify you are human" goes to a person through the help request (§6), never solved by the agent, and sites that forbid automated use still do.
- The license and NOTICE go in the app's about box and the runner's `licenses` output.

### 3. Turned on in two places

- **On the machine:** a fourth switch in `access.tools`, `browser`, set by the person on the computer (tray app or `agentes-runner access`), off by default. As with the other switches, the server can show it and ask to turn it off, never on. `hello.browser` reports whether the computer can serve it, whatever the switch (the switch itself travels in `access.changed`, so turning it on needs no reconnect).
- **On the agent:** the scope `browser:use`, outside "all tools" (like `sandbox:run`), on the agent's page next to its computer. Offered only when the agent's computer reports `browser` on; disabled with the reason otherwise.

### 4. One browser per agent, logins kept

- Session `agent-<id8>`, persistent profile and downloads in the agent's folder (`<handle>-<id8>/.agentes/browser`), headless, idle shutdown after 15 minutes. A login done once stays until the site ends it.
- The runner owns the Chrome process: it stops it after the idle time (not while a person watches or a help request is open), on `browser.stop`, on the agent's `close` and when it stops; a read never starts one. Pids go in `<runner home>/browser/chromes.json`, so Chromes a crashed runner left are stopped on its next start (only when the pid is still that Chrome on that profile).
- Per agent, not shared: another agent signs in on its own. Per computer: an agent moved to another computer signs in again.
- The agent signs in to whatever account the person tells it to: it types a password only when it was given one through `request_secret`, otherwise it asks the person (§6). No rule about which accounts; the agent's page says only "The agent stays signed in to the sites it enters, on this computer". Real payments, deletions and sending on someone's behalf still go through an approval. Until protected mode exists, other unprotected agents and the owner can read that folder.
- Optional site allowlist per agent, enforced by the runner: `agent-browser`'s `--allowed-domains` refuses persistent profiles, so the runner checks a navigation's URL before it goes and the page's URL after every action (going back when it left the list). Top-level pages only: sub-resources aren't filtered. `file://` and the owner's paths blocked.
- Cap of live browsers per machine (owner setting, default from memory, about 300 MB each); over it the agent sees "waiting for the computer".
- The runner serializes commands per session (one at a time, like the daemon), times them out and checks the session before reading.

### 5. Tools

Named `browser_*` (the `computer_*` names are the Daytona lifecycle):

- `browser_open(url)`, `browser_back`, `browser_tabs` (list, open, switch, close)
- `browser_read` → the snapshot as text with refs, wrapped as untrusted content, capped in size
- `browser_click(ref)`, `browser_fill(ref, text)`, `browser_select(ref, value)`, `browser_check(ref)`, `browser_press(key)`, `browser_scroll`, `browser_upload(ref, file)` (a file from the agent's folder)
- `browser_type_secret(ref, secret)`: types a secret already delivered with `request_secret`; the runner reads it locally; refused when the target isn't a password or one-time-code field
- `browser_wait(text | url | selector | load, timeout)`
- `browser_screenshot`: saved in the agent's folder (Claude Code and Codex read it there); image results for gateway brains come with ADR 0031 step 2
- `browser_ask_person(instructions, timeout)`: the handoff (§6)
- `browser_close`

Refs go stale after navigation; the tools say so (`stale_ref`) and the agent reads again. Every brain gets the same tools: gateway brains through the Tool Gateway, Claude Code and Codex through the runner's `agentes` MCP bridge.

### 6. Handoff: the agent asks, a person does it, the agent checks

Modeled on Cloudflare's handoff:

1. The agent calls `browser_ask_person("Sign in to Stripe with the shop's test account", 30 min)`. The run suspends, like `request_secret` and approvals.
2. A card in the chat ("Dev needs you · Sign in to Stripe · Open"), at the top of "Waiting for you" in notifications, and a push to the phone. It goes to both the person who asked for the work and the agent's responsible person (once when they are the same); the first to open takes control, the other sees "Walter is helping".
3. The person opens a full-screen live view (§7) with the agent's instructions on top, a "you're in control" badge, and two buttons: **Done** and **Couldn't**, each with an optional note. The agent reads every note; the card and the conversation's events carry only Couldn't's (the card shows it).
4. The agent resumes with `{ result: done | failed | cancelled | expired, note? }` and the facts of the person's turn (below), reads the page again and checks the outcome (still on the login page → it says so in the chat instead of carrying on). The card resolves itself.

A person watching can also **take over** on their own, while the agent may use its browser (`browser:use`, §3; 403 otherwise): the same screen; the agent pauses and, when handed back (**Hand back**, with an optional note), is told a person used its browser, with the same facts, and reads again before acting.

- **Facts, not a diff:** what the agent reads on resume says who had control, for how long, the page (address and title) when they took it and when it ended, and their note, quoted and marked as the person's own words. The pages come from the live view's newest frame, else a quick `get url` on the computer; they are kept in memory only (like the frames), so after a restart or on another replica the text says less. The site's title is quoted as data, never instructions.
- **A person can open a site** while in control (`POST …/agents/{agentId}/browser/open {url}` → 204): only the person in control (409 `browser.not_in_control`), only while the agent may use its browser (`browser:use`, §3) and its computer serves it (403, the same checks as its tools), http(s) only (a bare host gets `https://`; anything else 400 `browser.bad_address`), and the agent's site list holds: the runner checks it as for the agent's own `open` (403 `browser.not_allowed`). A closed browser opens (the runner starts Chrome), so a person can open the agent's browser from its page to sign in before giving it work; the live view starts its stream at once (`browser.opened` on the handoff topic). A page that fails to load is 400 `browser.open_failed`, and Chrome's error page shows.
- Taken from a run's card, the take over is bound to that run (`runId`): its card stays in that run's conversation (on the run's last message, else at the end) while the person holds control, even after the run's live block goes, and `browser.handoff.updated` goes to that conversation. Taken from the agent's or the computer's page it has no run until a run's browser call waits on it; the tray links to the run's conversation, else to the agent's page with its browser open (`/org/{orgId}/agents/{agentId}?browser=1`).
- If the run under a take over ends (done, failed, canceled) while the person keeps control, the person keeps the browser and the card stays; the agent's next run that needs the browser takes the take over over (it waits on it, and the card moves to it), so it is never "busy" forever. A run still going keeps it (other runs are refused).
- Leaving without handing back (expired) is told to the agent as such, not as handed back. "Parar" is heard by everyone watching (`browser.stopped` → `browser.ended` with who and when).

- One person in control per agent browser. While someone is in control only they get frames (at the control rate): the other viewers' `browser.status` says `hidden` and who is in control ("Ana is in control · screen hidden"), and they get the page again, the newest frame at once, when it is handed back. What a person types in the agent's browser isn't watched by others.
- Timing, as in OpenBot and OpenMausBot: a request waits 10 minutes for someone to open it (the agent may ask for up to 30), then expires; once a person is in control there is no deadline; if their view drops, control is kept for 2 minutes (presence renewed every 30 s and stored in the database, so it holds across replicas and restarts), then it ends as `expired`.
- While a request is open (waiting or in control) the agent's browser tools wait or refuse; after a person had control, only `browser_read` works until the agent reads the page again (`page_read_at`, migration 0080), as OpenBot requires a fresh snapshot after hand back. The refusal repeats the facts of the person's turn.
- The agent's browser stays alive while a request is open (the server keeps the session active so the 15-minute idle shutdown doesn't close it).
- Who may watch, take control or cancel: org admins, the agent's owner, the people the request went to and whoever asked for the work; a channel reader can't. Access is checked again every 30 s while watching and before each input.
- Nothing reaches the model during a handoff: no frames, no keys.
- Passkeys and hardware keys don't cross a remote view; the person picks another sign-in method.
- We never copy cookies from the owner's own browser.

### 7. Live view: `agent-browser`'s JPEG stream, in memory

- The runner opens the session's local stream only while someone watches and forwards frames over its machine socket, with the active tab's address and title. The server relays them to the viewers' sockets in memory: nothing written to Postgres, nothing stored.
- Adaptive: about 1 fps while watching, 10–15 fps while a person is in control. Chrome only sends frames when the page changes; newest frame wins, stale frames are dropped. Smaller frames on the phone.
- **First frame:** Chrome sends no screencast frame for a page that isn't repainting, and `agent-browser`'s stream only replays a frame it already has (checked in 0.39.1's source: its own recordings seed a screenshot for that reason). So a new stream with no frame after 1 s gets one JPEG screenshot as its first (through the session's command queue), and the relay holds the newest frame of a running stream in memory: a viewer who joins, or whose view stops being hidden, sees the page at once. An idle open browser shows a picture, not a spinner.
- **Closed:** a stream can't start on a closed browser (never opened, idle shutdown, Stop, the agent's `close`): the runner says `browser_closed` and viewers get `browser.unavailable` with reason `closed` (an older runner's `bad_request` stays `unavailable`, with its message). The app keeps watching with backoff (up to 10 s), so the view shows the browser once something opens it (the agent, or a person in control opening a site, which also restarts the stream at once). No frame is kept for a closed browser: the app shows that it is closed, and that logins stay.
- Input from the person: mouse and touch as stream input events (coordinates mapped from the displayed frame to the page); special keys as key events, completed with `agent-browser`'s key resolver; Command mapped to Control where the shortcut expects it; paste forwarded.
- **Typing through a native text field:** the app shows its own text field (secure for passwords) and sends the whole text into the focused page field (`keyboard inserttext`). Accents work, and the phone's and password manager's autofill fill it.
- Popups and new tabs (OAuth windows) followed: the view switches to the active tab.
- The viewer reconnects by itself (backoff), so a deploy (`overlapSeconds`) or a network drop shows "reconnecting…" and carries on.
- The relay sits behind a small interface of ours (`StreamRelay`), in memory today. Frames come from a `FrameSource` (JPEG today).
- Load: the server only copies bytes. About 25–50 KB per frame; a 2–3 minute login is about 30–75 MB; nothing while nobody watches.

### 8. What is stored

- Not stored: frames (the relay holds only the newest frame of a running stream, in memory; the first-frame screenshot is deleted on the computer once sent), screenshots (they stay in the agent's folder), the profile and cookies (on the computer), what a person types, the pages of a person's turn (in memory until the agent reads the page again).
- Stored: the run's transcript as for any tool (the `browser_*` calls and results), model usage and cost as for any model call, and one record per handoff or take over (who, when, result). No per-action audit table.
- After the run, the agent's message keeps where it browsed (`meta.browser.steps`: each `browser_*` call's tool, the site of an open without its query string, the time, whether it failed) for the card that stays in the chat. It shows a drawn page, never a picture of the real one.

### 9. Watching and stopping

- Live view on the run and on the machine page ("Dev is in the browser · shop.example/checkout"), with Watch and Stop.
- Always there, run or not (status, preview, take over; the card in the chat stays the default): a "Navegador" entry on the agent's page and its side panel, in the agent's DM header, and on the phone's agent profile, for the agent's owner and admins once it has `browser:use` and its computer serves the browser (the others who may watch, §6, get it where the request or the run is; the phone's profile also shows them a waiting request and a person's turn). It opens the same live view: Watch, Take over, Stop, and while in control an address field and Hand back with a note. The phone has no address field yet, so it offers Take over and Stop only while a page shows. The tray's Ver opens it too (`?browser=1` on the agent's web page).
- Stop closes the session at once.
- Checkout only in test mode; a real payment or any sensitive action the agent recognizes becomes an approval card as usual. Page text never grants permissions or skips an approval.

### 10. Runner protocol 12

- `access.tools.browser`; `hello.browser { available, version, chrome, reason? }`.
- Ops: `browser.act { agentId, command, args }` (one `agent-browser` command, returns its JSON), `browser.stop { agentId }`, `browser.stream.start | stop { agentId, mode: watch | control }`, `browser.input { agentId, events[] }`; frames come back as `browser.frame` on the machine socket (`metadata: { deviceWidth, deviceHeight, pageScaleFactor?, url?, title? }`). A stream start on a closed browser fails with the error code `browser_closed` (older runners: `bad_request`).
- The server only offers the tools to agents whose machine reports protocol 12 with the browser on.

## Order

First version: stages 0–7. Difficulty: **easy** (known pattern, little risk), **medium** (new pieces on known patterns).

| Stage | What | Difficulty |
|---|---|---|
| 0. Try by hand | `agent-browser mcp` in the MCP config of a Claude Code task on one Mac, against our app, a Stripe test checkout and a few common sites. Note snapshot size, stale refs, covered clicks, the keyboard gaps. No code. | Easy |
| 1. Runner core | Protocol 12; `access.tools.browser`; download with pinned hash; Chrome detection and download; `hello.browser`; `browser.act`, `browser.stop`; one session per agent with its profile; per-session command queue and timeouts; idle shutdown; orphan cleanup; Stop. | Medium |
| 2. Tools and screens | `browser:use`; the `browser_*` tools in the Tool Gateway and the MCP bridge; stale refs and output size; agent page and machine page. Prototype approved first. | Medium |
| 3. Desktop app sidecar | Second `externalBin`, signed and notarized in CI, license in the about box. | Medium |
| 4. Safety | `browser_type_secret`, allowlist, per-machine cap, untrusted-content wrapping, blocked paths, the "test or agent accounts" rule and line. | Easy |
| 5. Handoff | `browser_ask_person`, suspended run, card, "Waiting for you", push, Done/Couldn't, timeout, the agent checks; take over while watching. Prototype approved first. | Easy–medium |
| 6. Live view | Stream bridge (`StreamRelay` in memory), adaptive fps, input, tab following, reconnect, web and phone viewers. | Medium |
| 7. Native typing | The app's text field into the page's focused field, secure for passwords, autofill. | Medium |

Later, each when there is a reason:

| What | When | Difficulty |
|---|---|---|
| Several replicas: a direct connection between replicas (the machine's replica recorded once; frames over an internal socket), or Redis pub/sub if the Cloud already has it | When the server runs more than one replica | Medium |
| Video: screencast → ffmpeg H.264 → WHIP → LiveKit or Cloudflare → WHEP viewers (also removes the replica question) | When bandwidth or smoothness hurts, or with the virtual desktop | Hard |
| Intent tools with Jev (`click_on`, `type_into`, `check`, `wait_until`) on snapshot text, after a gate of about 20 pages × 5 targets | After real use of the raw tools | Medium |
| Protected mode (ADR 0030): Chrome inside Seatbelt/bubblewrap | With ADR 0030 level 2 | Hard |
| Daytona, the simulator (Maestro), the virtual desktop (neko or Kernel's images) | Their own decisions | — |

## Consequences

- Agents browse on connected computers with any brain and any model, reading pages as text, and keep their logins per agent.
- A person helps from anywhere through one handoff: a card, a push, a live view, Done.
- No new infrastructure: one replica, frames in memory, nothing from the browser stored in Postgres.
- We depend on a third-party binary: pinned, hash-checked, behind our tools, replaceable by our own CDP code.
- A second native executable to sign and ship in the app, and a download path for terminal installs.
- One Chrome per active agent costs memory; the per-machine cap bounds it.
- Until protected mode, a login in an agent's profile is readable by other unprotected agents and the owner on that computer, hence the test-or-agent-accounts rule.
