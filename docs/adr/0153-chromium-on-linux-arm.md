# 0153. Agent browsers on Linux ARM run the distribution's Chromium

- Status: Accepted
- Date: 2026-11-07
- Amends: 0133 §1 ("One browser: Google Chrome stable, no fallback"), on Linux on ARM only
- Code: adapters `machine-protocol.ts` (`CHROMIUM_LINUX`, `usesChromium`, `CHROMIUM_NEEDED`, `browserNeeded`,
  `CHROME_FAILURES.missingChromium`); runner `browser.ts` (`chromeCandidates`, `findChrome`, `chromeName`,
  `confinedChrome`, `BrowserManager.startDir`), `main.ts` (`update`), `install-script.ts` (`on_arm_linux`,
  `get_browser`, `get_chromium`, `install_chromium`, `update_timer`, `chrome_or_warn`, `CHROMIUM_DESKTOP_ENTRY`)

## Context

ADR 0133 made the agents' browser the computer's own Google Chrome stable, with no fallback. Google publishes no
Chrome for Linux on ARM (no `google-chrome-stable` for arm64 in its apt repository), so an arm64 Linux computer,
such as a free ARM cloud VM running a self-hosted instance, connected fine but its agents had no browser at all:
the runner looked only at `/opt/google/chrome/chrome`, and the installer pinned agent-browser's x86_64 build.
agent-browser itself ships an arm64 Linux build (already pinned in `AGENT_BROWSER_SHA256`).

## Decision

### 1. Linux on ARM drives Chromium

- `usesChromium(platform, arch)` is true on Linux on arm64 only. There, after Google Chrome's path (kept first in
  case Google ever ships one), the runner looks at `CHROMIUM_LINUX`: Debian's package (`/usr/bin/chromium`), then
  Ubuntu's snap (`/snap/bin/chromium`), Ubuntu having no Chromium package of its own. x86_64 Linux, macOS and
  Windows keep 0133 as it is: Google Chrome stable and nothing else.
- It is still the computer's own browser, never a copy of ours: updated by the distribution (Debian's security
  updates, or snap refreshes), version read with `--version` ("Chromium 157.0.8103.38 …"), and restarted on a new
  version exactly as 0133 §4 does for Chrome. The same flags and the same per-agent profile apply.
- What people see names it: `hello.browser.chrome` says "Chromium <version>" (`chromeName`), and the runner's log
  says the agent's browser "restarts on Chromium …".

### 2. The snap reads no hidden folder at the top of the home

The snap's confinement denies hidden entries directly under `$HOME`, so it can't open the agent's start page in
`~/.agentes-runner/start/…` (checked on Ubuntu 24.04 arm64 with Chromium 157: the page doesn't load, while a
profile in the agent's folder works). With a snap browser (`confinedChrome`: under `/snap/`) the start page is
written beside the agent's profile instead, in its own folder (`<agent>/.agentes/start/agentes-start.html`). Every
other browser keeps it under the runner's home. System mode is unchanged (its start pages are root's, and system
mode needs Debian, which has no snap Chromium).

### 3. The installer

- `--system` on arm64 installs agent-browser's `linux-arm64` build, checked against its own SHA-256, in the same
  shared folder.
- `--system` on arm64 without Chrome installs Debian's `chromium` with apt (no Google repository or key), puts the
  computer's default browser back, upgrades it with the same 6-hour timer (`agentes-chrome-update.timer`, now
  written by `update_timer` for either package), and with `--desktop` hides its menu entry
  (`/usr/local/share/applications/chromium.desktop`), as for Chrome.
- Without root (a person's install, `agentes-runner update`), an arm64 Linux computer without Chromium is told how
  to install it (`CHROMIUM_NEEDED`: `sudo apt install chromium` on Debian, `sudo snap install chromium` on Ubuntu),
  not to get Chrome from google.com.

### 4. What the agent is told

On Linux on ARM a missing browser is `CHROME_FAILURES.missingChromium`. It starts like `missing`, so
`chromeFailureKind` and the reports stay as they are.

## Consequences

- An arm64 Linux computer (a Debian server, an Ubuntu VM in user mode) gives its agents a browser.
- Chromium's client hints say "Chromium" where Chrome's say "Google Chrome"; the emulated brands
  (`browser-traffic.ts`) are unchanged.
- The notice people get when a computer has no browser (`machines.chromeMissingNotice`) still names Google Chrome;
  on an ARM computer it should name Chromium. Left for later: it needs the computer's architecture on the
  notification and the text in every language.
