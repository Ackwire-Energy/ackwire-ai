# 0042. The agent's phone simulator on connected computers

- Status: Proposed
- Date: 2026-10-20
- Planning: D64
- Extends: ADR 0025 (connected computers), ADR 0031 §5 and §13 (computer use: simulator, explorations become tests), ADR 0040 (agent browser: tools, handoff, live view)
- Out of scope for now: real phones over USB, cloud device farms, iOS on Daytona (it can't run the simulator), the Android live view in the phone app, protected mode (ADR 0030)

## Context

ADR 0031 §5 planned the simulator as `xcrun simctl` + `idb` (iOS) and `adb` (Android), with Maestro to save flows as tests. Since then we shipped the agent browser (ADR 0040): `browser_*` tools for every brain, a Cloudflare-style handoff, a JPEG live view relayed in memory, all in the chat card. The question was whether the simulator should be "Maestro" or "what Orca does", and whether it can reuse the browser's path.

### How others do it (checked 2026-10-20, code read, nothing run)

| | iOS | Android | Live view | Person takes over |
|---|---|---|---|---|
| **Orca** (Stably, MIT) | `simctl` for the device list and boot; **serve-sim** (Evan Bacon/Expo, Apache-2.0) for frames, input and the accessibility tree through Apple's private CoreSimulator/SimulatorKit (IOSurface capture, Indigo HID events) | `adb`, `emulator`, `uiautomator dump`; **scrcpy-server** 2.4 (Apache-2.0) for an H.264 stream; input still `adb shell input` | iOS: MJPEG from serve-sim, capped at 30 fps; Android: H.264 decoded with WebCodecs onto a canvas | Yes: the pane and the agent share one stream and one helper |
| **OpenMausBot** (Apache-2.0) | None | Physical USB phones only (emulators refused on purpose), bundled platform-tools, raw `adb` | A full PNG about every 0.85 s, desktop app only | No handoff; only a per-turn lock between agent threads |
| **OpenBot** (CopilotKit, MIT) | None | None | — | — |

What Orca gives the agent: an `orca emulator …` CLI (`list`, `attach`, `tap`, `gesture`, `type`, `button`, `rotate`, `ax`, …) taught by a skill file; the screen is read as an accessibility tree (at most 500 nodes, frames normalized 0..1), with no screenshot verb. OpenMausBot's `read_screen` is the same idea (at most 250 text lines with bounds, `tap_text` on a match, read again after every action). OpenMausBot first locked the phone for the whole turn as soon as the skill matched, which broke other turns running at the same time (their issue #1663); they now lock at the first real phone tool call.

### Tools (checked 2026-10-20)

- **Maestro** (Apache-2.0) is a test format and runner (YAML flows). Good for saved tests; poor for live exploration: `maestro mcp` has no direct tap tool, each command pays JVM startup, and it has no live view we could relay.
- **serve-sim**: headless (no Simulator window) MJPEG or H.264 stream, a WebSocket for touches, buttons and typing (US keyboard only), and an accessibility bridge. Node, arm64. Proven in a shipped product (Orca).
- **Baguette** (Apache-2.0, v0.2.x): one Swift CLI for headless boot, 60 fps MJPEG/H.264, multi-touch, keyboard, buttons and `describe-ui` as JSON, plus a JS SDK. More complete than serve-sim but very young.
- **idb** (Meta, MIT): active again (Swift rewrite, Xcode 26 required), but a Python client plus a companion per device is a heavier install.
- **AXe** (MIT): good one-shot CLI, but `describe-ui` restarts `testmanagerd`, which ends every XCUITest session on the Mac (Maestro's iOS driver, other agents) (AXe issue #76). Not a primary driver.
- **mobilecli** is FSL-1.1 (no competing use): not embeddable. Appium/WebDriverAgent: heavy and slow for this.
- Android: `adb` + `uiautomator dump` + **scrcpy-server** (H.264, and a control socket faster than `adb input`).

Risks found:

- Every headless iOS tool uses Apple's private frameworks and can break with any Xcode release.
- **Xcode 27 replaces Simulator.app with Device Hub**, which can disconnect the legacy touch and keyboard services. serve-sim and Baguette ship a "repair input" that restarts SpringBoard (closes running apps). Clone simulators may not show in Device Hub.
- A simulator booted only with `simctl` may have no framebuffer until a tool attaches one (reported by an idb_companion user).
- No end-to-end latency numbers published anywhere; our server relay will dominate, as it does for the browser.

## Decision

### 1. Two layers: live driving like Orca, Maestro only for saved tests

- **Live (exploration, live view, take over):** the runner drives the simulator itself, the Orca way.
- **Saved tests:** when a flow works, the agent writes it as a Maestro YAML in the project and a routine reruns it with almost no model (ADR 0031 §13). If Maestro's startup or fixed iOS driver ports block parallel runs, `maestro-runner` reads the same YAML.

### 2. iOS: `simctl` + one driver behind an interface

- `xcrun simctl` for create, boot, erase, install, launch, deep links, permissions, location, appearance, push.
- A **simulator driver** in the runner for frames, input and the accessibility tree. First choice **serve-sim** (proven in Orca, TypeScript/Node like the runner); **Baguette** as the second implementation of the same interface. Pinned versions, hash-checked, shipped like the `agent-browser` sidecar.
- AXe and idb are not used as the main driver (AXe kills XCUITest sessions; idb is a heavier install). idb stays a possible fallback.

### 3. Android: `adb` + scrcpy

- `adb` for install, launch, permissions and logs; `uiautomator dump` for the tree.
- scrcpy-server for frames (H.264) and, later, fast input over its control socket; `adb shell input` first.
- Comes after iOS (see §6, the live view).

### 4. Same path as the browser: one "screen" for both

Most of ADR 0040 is reused. The browser-only names become a **screen** with a kind (`browser` | `simulator`; the virtual desktop later fits the same shape), instead of copying everything as `simulator*` (MVP: no compatibility layer, one relay and one handoff to maintain):

| From the browser | Change |
|---|---|
| Machine socket and hub (`machine-hub.ts`, `machine-protocol.ts`) | New ops only |
| Live relay (`browser/live.ts`, `StreamRelay`, `BrowserFrame`) | Generalized to screen frames with a `FrameSource` per kind; serve-sim's MJPEG is JPEG frames, so it fits as is |
| Person's input (`realtime/browser.ts`, `BrowserInputEvent`, 25 ms batches) | Generalized; `touch` already exists, add hardware buttons and rotate |
| Handoff (`browser/handoff.ts`, `browser_handoffs`) | Same rules (10 min to open, 2 min grace, agent paused, re-reads after hand back), keyed by screen kind; new migration |
| Chat card that becomes the live view (web + mobile) | Same card, a phone frame instead of the address bar |
| Scope, tools for every brain, notifications, push | Same pattern |

### 5. Tools

- `phone_*` tools for every brain (Tool Gateway in the cloud, the `agentes` MCP for Claude Code/Codex), never the raw CLI: `phone_devices`, `phone_install`, `phone_open_app`, `phone_open_link`, `phone_read` (the screen as text with a number per element, coordinates 0..1), `phone_tap` (by number or text; a point only as fallback), `phone_type`, `phone_type_secret`, `phone_swipe` (by direction), `phone_button` (home, back, lock, rotate), `phone_wait`, `phone_screenshot` (visual checks), `phone_ask_person`, `phone_close`.
- Structure first: the agent reads the tree after every action; screenshots are for visual checks.
- Sensitive actions (pay, delete, send on someone's behalf) become approval cards; screen text never grants permissions.

### 6. One simulator per agent, locked lazily

- Each agent gets its own device (own device ID, own driver process, ports picked at random) so two agents never install over each other's app; per-agent build caches (`xcodebuild -derivedDataPath` in the agent's folder).
- The device is claimed at the first real `phone_*` call and checked on every call, never for the whole turn on a guess (OpenMausBot #1663).
- The runner reports `simulator` (with platforms and runtimes) only on a Mac with Xcode or a machine with the Android SDK; the server only offers the tools there. Switch on the machine plus a scope per agent, as for the browser.

### 7. Live view

- iOS: the driver's MJPEG frames go through the same relay as the browser, only while someone watches, about 1 fps watching and 10–15 fps in control.
- Android: scrcpy sends H.264, which the relay doesn't carry and the phone app can't decode without a native module. Open choice when Android starts: the runner converts to JPEG (simple, CPU on the computer) or the relay carries video (web decodes with WebCodecs, phone needs native decoding).

### 8. Testing: not on the developer's Mac

The developer's Mac doesn't have the memory to run simulators for this work. The spike (serve-sim vs Baguette on Xcode 27 / iOS 27: headless boot, frames, touch, typing, tree, two simulators at once, Device Hub repair) runs on a **rented Mac paired as a connected computer** (already our test case for the desktop, ADR 0031), or a one-off manual macOS CI job if the rented Mac isn't ready. Nothing from the spike is committed.

## Order

1. Spike on a rented Mac (§8); pick the first driver.
2. Generalize the browser's live relay, input and handoff to a screen kind (no behavior change for the browser).
3. Runner: `simctl` + driver, next protocol version, `hello.simulator`.
4. `phone_*` tools, the card with a phone frame (prototype first), handoff.
5. Saved flows as Maestro tests rerun by routines.
6. Android: `adb` + scrcpy, then the live view choice (§7).

## Consequences

- Phone app testing reuses the browser's live view and handoff instead of building a second set.
- We depend on Apple's private simulator APIs through a third-party driver; two drivers behind one interface and pinned versions limit the damage of an Xcode update.
- iOS needs a Mac with Xcode and enough memory; agents without one don't get the tools.
- Commands run as the OS user, and Seatbelt (protected mode) likely breaks `simctl`; isolation for a QA agent stays a dedicated OS user, a rented Mac or a macOS VM (ADR 0031 §5).
