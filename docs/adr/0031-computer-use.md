# 0031. Computer use: a browser of the agent's own, a virtual desktop, and (opt-in) the owner's real desktop

- Status: Proposed (after missions, ADR 0029, and runner isolation level 1, ADR 0030)
- Date: 2026-10-16
- Planning: D44
- Extends: ADR 0021 (code sandbox), ADR 0025 (connected computers), ADR 0027 (secrets), ADR 0030 (runner isolation)

## Context

Agents can run commands and move files on their computer (Daytona or a connected machine), but they can't see or drive a screen. Many tasks need one: a web app without an API, a form, an admin panel, a desktop program, checking that a UI the agent just built actually works.

The runner today has six ops (`exec`, `read`, `write`, `list`, `push`, `secret`); nothing captures the screen or sends input. With `exec` an agent can already run a headless browser if one is installed, but there is no tool, no screenshot path to the model and no way for people to watch.

Model side (Anthropic, checked 2026-10-16):

- Computer use is a client-side tool: we provide the screen and execute the actions. Current shape is the **computer toolset** `computer_toolset_20260801` (GA on the Claude API and Google Cloud, no beta header): one `tools` entry with no `name` or display size; calls come back as `tool_use` blocks whose `name` is the action (`screenshot`, `left_click`, `type`, `zoom`, …) with `"toolset_name": "computer"`, often several per turn; every `tool_result` must echo `toolset_name`; only `screenshot` and `zoom` return an image. Claude Opus 5.5 and Sonnet 5.5 accept only the toolset on the Claude API (the older `computer_20251124` returns 400).
- There is also a **browser toolset** `browser_toolset_20260801` for work inside web pages.
- Coordinates are in the pixel space of the screenshots we return, and screenshots must already fit the model's image limits (no server downscale). About 1080p is a good cost/accuracy balance; 1366×768 or 720p for cheaper runs.
- Don't prune old screenshots on our side: editing earlier turns invalidates later thinking blocks (preserved thinking). Use server-side tool result clearing instead.

Our side today: tool results are text only (`packages/providers/src/anthropic.ts`); the Tool Gateway has no image results and no provider-defined tools.

## Decision

### 1. Three kinds of screen, one tool

| Screen | Where | What the agent reaches | Isolation |
|---|---|---|---|
| **Agent browser** | Daytona computer or connected machine | A Chromium the runner starts, with a profile per agent in the agent's folder. Not logged in to anything of the owner's. | Works with every isolation level |
| **Virtual desktop** | Daytona computer, or a Linux VM/container the owner provides (level 3) | A full desktop on a virtual display (Xvfb + a window manager), inside the box | The box is the boundary |
| **Owner's desktop** | Connected machine that supports it (`--desktop`), given to one agent at a time by the machine's owner | The real screen, mouse and keyboard of the person logged in | None: acts as the owner (see §4) |

The agent sees one tool family, `computer_*` (scope `computer:use`, outside "all tools", like `sandbox:run`). `computer_status` (already exists) says which screen it has, if any.

The real trade-off is not "computer use or terminal": only the owner's desktop rules out the sandbox (§7). An agent with a terminal and the agent browser, or a virtual desktop, keeps protected mode.

### 1a. Chosen per agent

Each agent has two settings on its page, next to the computer it uses (`agents.machine_id`, ADR 0025):

- **Screen** (`agents.screen`): `none` (default) · `browser` · `virtual_desktop` · `owner_desktop`.
- **Protected mode** (`agents.protected`, ADR 0030 level 2): on or off.

What can be chosen depends on the computer, and options that don't apply are shown disabled with the reason:

| Screen | Cloud (Daytona) | Connected machine |
|---|---|---|
| `none` | yes | yes |
| `browser` | yes | yes (runner protocol 4 with the `browser` capability) |
| `virtual_desktop` | yes | only on a machine that reports a virtual display (VM/container, level 3) |
| `owner_desktop` | no | only on a machine paired with `--desktop`, and only set by the person who paired it (not even an admin) |

- `owner_desktop` forces protected mode off for that agent; the page says "this agent acts as you on this computer". Turning protected mode on moves the screen back to `browser`.
- The screen is a ceiling: the agent can't raise it, and the server only offers the tools it allows. Changes are audited.
- Changing the agent's computer resets the screen to `none` if the new computer can't serve it.
- Machine side, `--desktop` only means "this machine can offer its desktop" (helper installed, permissions granted). It gives nothing to any agent by itself.

The recommended path for "use a computer" is the virtual desktop. The owner's desktop is for what only exists there.

### 2. Our action set, mapped per provider

The Tool Gateway gets a provider-neutral action set: `screenshot`, `zoom`, `click` (left/right/double/middle), `move`, `drag`, `scroll`, `type`, `key`, `wait`, and for the agent browser also `navigate`, `back`, `read_page` (text, cheaper than pixels).

- **Anthropic adapter:** declares `computer_toolset_20260801` (or `browser_toolset_20260801` for the agent browser), maps member calls to our actions and echoes `toolset_name`. Batches of calls run in order, stop on the first failure, and return one result each.
- **OpenAI adapter:** its own computer-use tool when we build it (to confirm against their docs then). Other providers: the agent has no screen tools.
- **Gateway changes:** image blocks in tool results; provider-defined tools; server-side clearing of old screenshot results (`clear_tool_uses`) instead of removing them from the transcript.
- **Cost:** every step is a normal model call through the gateway (budget checked before, usage recorded with `org_id` and `agent_id`). A connected machine costs us nothing in compute, but the model calls are ours. A computer session has a step cap (default 200) and a time cap (default 30 min) per run; the agent asks to continue past them.

### 3. Screenshots

- Captured on the computer, downscaled there to fit the long edge in 1920 px (default 1280×800 for virtual desktops), PNG or JPEG. The runner keeps the scale factor and translates the model's coordinates to real screen pixels (Retina, HiDPI, several monitors: one chosen monitor per session).
- Stored in the org's file storage, not inline in the transcript: the transcript keeps a reference, the gateway loads the bytes when it builds the request. Retention 7 days by default (org setting), then the transcript shows "screenshot expired".
- Visible only to who can see the run. They may contain other people's personal data (LGPD): short retention, never indexed by search, never used for memory.
- Screen content is untrusted input (prompt injection). The system prompt says so, and nothing on the screen can grant permissions or skip an approval.

### 4. The owner's real desktop

What it means: the agent does whatever the owner's session can do, with their logins, files and open apps. Treat it like giving someone remote control.

- **Two opt-ins:** the machine offers it (`agentes-runner pair … --desktop`, or later from the machine page, by the person who paired it), then that person gives it to a specific agent (§1a). The pairing screen spells out the consequence.
- **Native helper:** the runner is a JavaScript bundle and can't capture the screen or inject input on its own. A small signed helper per OS (`agentes-desktop`) is downloaded only when desktop mode is on:
  - macOS: ScreenCaptureKit + CGEvent. Needs Screen Recording and Accessibility permissions, granted by hand in System Settings (we show how). The helper must be signed and notarized, so permissions stick to it and not to `node`.
  - Linux X11: `xdotool` + `xwd`/`import`, or the helper. Wayland: the RemoteDesktop/ScreenCast portal, which asks the user each session; documented as limited.
  - Windows: helper with `SendInput` and Desktop Duplication.
- **One controller at a time:** a machine-wide lock; a second agent asking for the desktop waits or is told it is busy.
- **The person wins:** if the helper sees local mouse or keyboard input that it didn't send, the agent's session pauses and the agent is told. An on-screen indicator shows "<Agent> is using this computer" with a Stop button.
- **Two modes, chosen by the owner:** *watched* (runs only while someone with access has the live view open) and *alone* (runs unattended within the caps). Default: watched.
- **Session approval:** starting a desktop session is an approval card in the chat (who, what for, how long), approved by the machine owner. Agent browser and virtual desktop sessions don't need it.
- **Approvals are not binding here.** With the owner's logins, the agent could click "Merge" in a browser where the owner is signed in. Same limit as ADR 0030 states for credentials; the docs say it plainly and recommend the virtual desktop or the agent browser for anything that matters.
- **A rented Mac is one option, not the recommendation.** A Mac rented in the cloud (MacinCloud and similar) is just another connected machine: the runner needs Node 22+ or Bun, outbound HTTPS/WebSocket and a user-level launchd agent (no admin). For the owner's desktop it also needs a logged-in graphical session (automatic login) and the two permissions granted once over remote access. Plans without admin rights or that end background processes at logout may not work; the docs list these checks. Whatever logins are left open on that Mac still apply to the agent.

### 5. Watching and stopping

- **Live view** on the run and in the machine page: the latest frames over the WebSocket (about 1 fps, only while someone is watching), the action log next to them.
- **Stop** ends the session at once (cancel to the runner, lock released). **Take over** pauses the agent until the person hands back.
- Every action is audited (`computer.action`, with the action, not the typed text when it goes into a password field we can detect).

### 6. Secrets on screen

`type_secret(name)` types a secret already delivered with `request_secret` (ADR 0027) into the focused field. The model never sees the value; the runner reads it locally. A screenshot can still show it if the field isn't masked; the tool warns when the focused element (agent browser only, from the accessibility tree) isn't a password field.

### 7. How this fits the isolation levels (ADR 0030)

| | Agent browser | Virtual desktop | Owner's desktop |
|---|---|---|---|
| **Level 1** (environment per agent) | Yes. Profile and downloads in the agent's folder. | n/a (lives in a box) | Yes, but level 1 isolates git, not the screen: every agent with desktop access sees everything. |
| **Level 2** (Seatbelt / bubblewrap) | Yes, with an adjusted profile: Chromium needs its own cache dir, GPU/shm access and network (allowlist works). Chromium's sandbox inside ours needs testing on each OS; fall back to `--no-sandbox` only inside our sandbox. | n/a | **No.** Driving the real screen escapes any process sandbox: one click opens Terminal and types a command as the owner. So an agent has either the owner's desktop or protected mode, never both (§1a). Other agents on the same machine can still be protected. |
| **Level 3** (dedicated user / VM / container) | Yes. | **Best fit**: a VM or container with Xvfb is a full desktop the owner's machine never exposes. We document the image. | A dedicated OS user has no graphical session unless one is logged in (macOS fast user switching, Linux a second X session); possible, not something we manage. |
| **Daytona** | Yes (Chromium in the image). | Yes: Xvfb + window manager in our image, actions via `xdotool`. Network follows the org's mode. | n/a |

So the safe default is: agent browser everywhere, virtual desktop for full computer use, owner's desktop only as an explicit, per-agent, watched-by-default choice.

One limit to state: protected mode limits what *that* agent reaches. It doesn't hide a protected agent's folder from an unprotected agent on the same machine (one with the owner's desktop, or just a shell without the sandbox), since those act as the owner. Agents that must not see each other's work need protected mode on both, or separate machines.

### 8. Runner protocol 4

New ops: `screen.info` (monitors, scale), `screen.capture { monitor, maxEdge, format }`, `input { actions[] }` (batch, stops on first error), `browser.start | browser.stop | browser.act`. The runner advertises `capabilities: ["browser", "desktop"]` in `hello`; the server only offers tools a machine can serve. Older runners get no screen tools.

## Order

1. Gateway: image tool results stored in file storage, provider-defined tools, the Anthropic toolset mapping, screenshot clearing. Tests with the fake provider.
2. Agent browser on Daytona and on the runner (protocol 4), live view, Stop, caps.
3. Virtual desktop in the Daytona image; documented VM/container image for level 3.
4. Owner's desktop: macOS helper first (signing, permissions flow), then Windows, then Linux X11; per-agent choice that turns protected mode off; session approval card.
5. `type_secret`.

Test case: a rented Mac (MacinCloud) paired as a connected machine runs the whole path end to end (pairing, `--desktop`, permissions, automatic login, an agent with `owner_desktop`, live view, Stop, local input pausing the agent, reconnection after the provider restarts the Mac).

## Consequences

- Agents can use web apps and desktop programs, with people able to watch and stop them.
- Most screen work happens in places we or the owner isolate (agent browser, virtual desktop); acting as the owner is rare, explicit and visible.
- Computer use is expensive (an image per step); caps and the budget keep it bounded, and `read_page` avoids pixels where it can.
- We ship and sign native helpers per OS for desktop mode, which the rest of the runner avoided so far.
- Approvals stay binding everywhere except the owner's desktop, and we say that out loud.
- Screenshots add personal data we store; short retention and no indexing limit it.
