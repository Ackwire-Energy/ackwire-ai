# 0040. The agent browser on connected computers, built on `agent-browser`

- Status: Proposed
- Date: 2026-10-19
- Planning: D57
- First slice of: ADR 0031 (computer use). Where the two disagree, this ADR wins for the browser.
- Extends: ADR 0025 (connected computers), ADR 0027 (secrets), ADR 0030 (runner isolation), ADR 0032 (one engine, the runner MCP as a bridge), ADR 0036 (desktop app, access on the machine)
- Out of scope for now: Daytona computers, the simulator (Maestro, its own ADR), the virtual desktop, the owner's desktop, pixel-driving through provider computer-use tools

## Context

ADR 0031 plans four kinds of screen. The browser carries most of the value (web apps without an API, test logins, Stripe test checkouts, checking a UI the agent just built) at the least risk, and it works at every isolation level. We take it first, on connected computers only.

ADR 0031 §4 planned to drive Chromium over CDP ourselves. A tool already does that for agents:

- **`agent-browser`** (Vercel Labs, Apache-2.0, `github.com/vercel-labs/agent-browser`): a native Rust CLI and daemon, one daemon per session, speaking CDP directly to an installed Chrome (or Chrome for Testing it downloads). No Node, no Playwright.
- `snapshot` returns the page's accessibility tree as text with refs (`button "Submit" [ref=e2]`); actions take a ref (`click @e2`, `fill @e3 "…"`); a click covered by another element fails with the covering element named. `wait --text/--url/--selector/--load`, tabs, frames, dialogs, upload, console, network, `screenshot` (`--if-changed`, `--annotate`).
- Per session: `--session`, `--profile <dir>`, `--allowed-domains` (also blocks sub-requests, WebSocket, beacons, WebRTC), `--content-boundaries` (untrusted page text delimited), `--max-output`, `--action-policy`, idle shutdown (1 h by default).
- A WebSocket stream per session: JPEG frames with viewport metadata and URL changes out, `input_mouse` / `input_keyboard` / `input_touch` in, fps capped per client. Made for "pair browsing".
- `agent-browser mcp`: the same surface as MCP tools, in profiles.
- It calls no model, except an optional `chat` command through Vercel's AI Gateway, which we don't use.

Orca (`stablyai/orca`) ships its built-in browser on it, bridged to an Electron webview over CDP. Most of Orca's own browser code is about keeping agent input out of the user's keyboard focus, because its browser lives in the user's window. Ours is headless on the runner, so that problem doesn't arise.

What we have today: the runner's machine-side switches (`hello.access.tools`: `claude`, `codex`, `commands`, protocol 10), agent folders, `request_secret` (ADR 0027), the `agentes` MCP bridge for Claude Code and Codex (ADR 0032), runner protocol 11. The existing `computer_start` / `computer_stop` / `computer_status` tools are about the Daytona computer's lifecycle.

## Decision

### 1. `agent-browser` behind our own tools

- The runner drives `agent-browser` (pinned version) as a child process with `--json`. Agents never get the raw CLI or its MCP server: they get our tools, so audit, Stop, allowlist, secrets, take over and caps hold whatever the brain.
- Our tools are the interface. If `agent-browser` changes course, we replace it with our own CDP code under the same tools without touching agents.
- Turned off on our side: its credential vault (secrets come from `request_secret`), importing auth from the owner's Chrome (`--auto-connect`, Chrome profile reuse), `chat`, plugins, its dashboard.

### 2. Where it runs: connected computers only

- Desktop app (macOS): `agent-browser` ships as a second Tauri sidecar next to `agentes-runner`. CI downloads the pinned release, checks its SHA-256, signs it with our Developer ID and notarizes it with the app. It updates with the app.
- Terminal installs (servers, Linux, Windows): the runner downloads the binary on first use from our server (same download route as the app), checks the SHA-256 pinned in the runner, into `~/.agentes-runner/bin/`. Machines that never use the browser download nothing.
- Chrome: the one already installed (Chrome, Brave, Chromium). If none, the runner runs `agent-browser install` (Chrome for Testing) on first use and the machine page shows the download. Linux without Chrome's libraries needs `install --with-deps` (sudo): the runner doesn't report the browser and the machine page shows the command.
- The license and NOTICE go in the app's about box and the runner's `licenses` output.

### 3. Turned on in two places

- **On the machine** (protocol 12): a fourth switch in `access.tools`, `browser`, set by the person on the computer (tray app or `agentes-runner access`), off by default. Like the other switches, the server can show it and ask to turn it off, never on. `hello.browser` reports whether it can serve (binary, Chrome, version).
- **On the agent**: the scope `browser:use`, outside "all tools" (like `sandbox:run`), on the agent's page next to its computer. Offered only when the agent's computer reports `browser` on; disabled with the reason otherwise.

### 4. Tools

Named `browser_*` (the `computer_*` names are the Daytona lifecycle):

- `browser_open(url)`, `browser_back`, `browser_tabs` (list, open, switch, close)
- `browser_read` → the snapshot as text with refs, wrapped as untrusted content, capped in size
- `browser_click(ref)`, `browser_fill(ref, text)`, `browser_select(ref, value)`, `browser_check(ref)`, `browser_press(key)`, `browser_scroll`, `browser_upload(ref, file)` (a file from the agent's folder)
- `browser_type_secret(ref, secret)`: types a secret already delivered with `request_secret`; the runner reads it locally; refused when the target isn't a password or one-time-code field
- `browser_wait(text | url | selector | load, timeout)`
- `browser_screenshot`: saved in the agent's folder (Claude Code and Codex read it there); image results for gateway brains come with ADR 0031 step 2
- `browser_ask_person(reason)`: asks for take over (§6) and suspends the run until the person hands back
- `browser_close`

Refs go stale after navigation; the tools say so (`stale_ref`) and the agent reads again.

Every brain gets the same tools: gateway brains through the Tool Gateway, Claude Code and Codex through the runner's `agentes` MCP bridge (ADR 0032). Model-agnostic: the page is text, so models without image input browse too.

### 5. One browser per agent

- Session `agent-<id8>`, profile and downloads in the agent's folder (`<handle>-<id8>/.agentes/browser`), headless, idle shutdown after 15 minutes. Logins persist in that profile.
- Optional site allowlist per agent (`--allowed-domains`). `file://` and the owner's paths blocked.
- Cap of live browsers per machine (owner setting, default from memory, about 300 MB each); over it the agent sees "waiting for the computer".
- Protected mode (ADR 0030 level 2): the browser runs inside the agent's sandbox with an adjusted profile (Chrome's cache, shm, GPU, network). To test on each OS before calling it supported; until then a protected agent's `browser:use` is offered with "not yet in protected mode".

### 6. Take over and live view

- The runner bridges the session's local stream to our WebSocket (through the machine channel) only while someone watches: about 1 fps watching, 10–15 fps in control.
- **Take over:** a card in the chat ("Dev needs you to sign in to Stripe · Take over"), from `browser_ask_person` or from a person on the run. The person's mouse, keys and touches go back as stream input; typed text through CDP `Input.insertText` if the stream's key events don't carry accents and paste well (to test). Popups and new tabs (OAuth windows) followed. One person in control per agent browser; others watch.
- Nothing reaches the model during take over. The audit records who and when, not what was typed.
- **In front of the computer:** the runner reopens the agent's profile `--headed`; the person signs in in a normal Chrome window (passkeys, password managers, the home IP) and closes it.
- Passkeys and hardware keys don't cross a remote browser; the person picks another method or uses the local window.
- We never copy cookies from the owner's own browser.

### 7. Watching, stopping, audit

- Live view on the run and on the machine page ("Dev is in the browser · shop.example/checkout"), with Watch and Stop.
- Stop closes the session at once.
- Audit `browser.action` per action (no typed text for secret fields).
- Checkout only in test mode; a real payment or any sensitive action the agent recognizes becomes an approval card as usual. Page text never grants permissions or skips an approval.

### 8. Intent tools with Jev (second step)

After the raw tools work, `browser_click_on(target)`, `browser_type_into(target, text | secret)`, `browser_check(condition)` and `browser_wait_until(condition)`:

- The runner sends the snapshot; the server asks the `ScreenJudge` (first implementation: Jev, Choice over the snapshot's elements, Noul for conditions) and the runner acts on the chosen ref. `wait_until` polls about once a second without the main model.
- On text, not pixels: no dependence on Jev's image preview.
- Low confidence → the tool fails and returns the snapshot to the main model.
- Called by the server only, usage and cost recorded with `org_id` and `agent_id`; the judge's name never in the UI.
- Gate: about 20 real pages × 5 targets (our app, a Stripe test checkout, a few common sites) for hit rate, latency and cost before turning them on by default.

### 9. Runner protocol 12

- `access.tools.browser`; `hello.browser { available, version, chrome, reason? }`.
- Ops: `browser.act { agentId, command, args }` (one `agent-browser` command, returns its JSON), `browser.stop { agentId }`, `browser.stream.start | stop { agentId, mode: watch | control }`, `browser.input { agentId, events[] }`, `browser.headed { agentId }`.
- The server only offers the tools to agents whose machine reports protocol 12 with the browser on.

## Order

Difficulty: **easy** (known pattern, little risk), **medium** (new pieces on known patterns), **hard** (open questions, may need a rework). Stages 0–4 are the first version: agents browse, log in with test accounts, and are stopped and audited. Live view and take over come right after.

| Stage | What | Difficulty | Why | Depends on |
|---|---|---|---|---|
| 0. Try by hand | `agent-browser mcp` in the MCP config of a Claude Code task on one Mac, against our app, a Stripe test checkout and a few common sites. Note snapshot size, stale refs, covered clicks. No code. | Easy | Configuration only | — |
| 1. Runner core | Protocol 12; `access.tools.browser` switch (tray + `agentes-runner access`); download on first use with pinned SHA-256 into `~/.agentes-runner/bin/`; Chrome detection and Chrome for Testing download; `hello.browser`; `browser.act` and `browser.stop`; one session per agent (profile in its folder, idle shutdown); orphan daemon cleanup when the runner restarts. | Medium | Ops and the access switch follow protocols 10–11. New: managing child daemons and their Chrome processes on three OSes without leaks. | 0 |
| 2. Tools and screens | `browser:use` scope; the `browser_*` tools in the Tool Gateway, also through the MCP bridge; stale-ref and output-size handling; screenshots in the agent's folder; agent page (scope offered only when the machine serves it, reason when not); machine page (browser available, version, who uses it, Stop). Prototype approved before the screens. | Medium | Same shape as the Postgres connector and machine access. The work is in tool descriptions that make models read before acting. | 1 |
| 3. Desktop app sidecar | CI fetches the pinned release, checks the hash, ships it as a second `externalBin`, signs it with the hardened runtime, notarizes with the app; the runner prefers the bundled binary; license in the about box. | Medium | Signing a bundled binary was already done for the runner. Risk: entitlements Chrome's child processes need, notarization rejects. | 1 |
| 4. Safety | `browser_type_secret` (runner reads the secret; refuses non-password fields, from the snapshot's role); per-agent allowlist; `browser.action` audit; per-machine cap with "waiting for the computer"; untrusted-content wrapping; `file://` and owner paths blocked. | Easy–medium | All on pieces from stages 1–2 and ADR 0027. Detecting password fields from the snapshot is the one detail to check. | 2 |
| 5. Live view | Bridge the session's local stream to our WebSocket through the machine channel (also across replicas, `machine_rpc`), only while someone watches, about 1 fps; viewer on the run and machine page, web and phone. | Hard | Frames are a new kind of traffic on the machine channel (size, backpressure, several replicas); rendering on web and phone. | 2 |
| 6. Take over | `browser_ask_person` suspends the run with a card; one person in control per agent browser; input back over the stream (coordinate mapping, touch from the phone); accents, IME and paste (CDP `Input.insertText` if the stream's keys don't carry them); OAuth popups and new tabs; local `--headed` window. | Hard | The most unknowns: keyboard fidelity, popups, phone input, handing back cleanly to the agent. | 5 |
| 7. Intent tools with Jev | Gate (about 20 pages × 5 targets: hit rate, latency, cost); `ScreenJudge` on snapshot text; `browser_click_on`, `browser_type_into`, `browser_check`, `browser_wait_until`. | Medium | The code is small; the open question is whether accuracy on real pages is good enough. If not, the raw tools stay the only path. | 2 |
| 8. Protected mode | Chrome inside Seatbelt (macOS) and bubblewrap (Linux) with an adjusted profile; tested per OS; until then "not yet in protected mode". | Hard | Chrome's own sandbox inside ours, GPU and shared memory; may not work on every OS. | 1, ADR 0030 level 2 |

## Consequences

- Agents browse on connected computers with any brain and any model, reading pages as text.
- We depend on a third-party binary: pinned, hash-checked, behind our tools, replaceable by our own CDP code.
- A second native executable to sign and ship in the app, and a download path for terminal installs.
- One Chrome per active agent costs memory; the per-machine cap bounds it.
- Daytona, the simulator and the other screens of ADR 0031 wait for their own decisions.
