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

1. Try it by hand: `agent-browser mcp` in the MCP config of a Claude Code task on one Mac, against our app and a Stripe test checkout. No code.
2. Runner: download/sidecar, `access.tools.browser`, `browser.act`, sessions per agent, cap, Stop. Server: scope, tools, agent page, machine page.
3. Secrets (`browser_type_secret`), allowlist, audit.
4. Live view and take over (remote, then the headed window).
5. Intent tools with Jev, after the gate.
6. Protected mode tested per OS.

## Consequences

- Agents browse on connected computers with any brain and any model, reading pages as text.
- We depend on a third-party binary: pinned, hash-checked, behind our tools, replaceable by our own CDP code.
- A second native executable to sign and ship in the app, and a download path for terminal installs.
- One Chrome per active agent costs memory; the per-machine cap bounds it.
- Daytona, the simulator and the other screens of ADR 0031 wait for their own decisions.
