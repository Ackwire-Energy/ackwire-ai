# 0064. The agent's computer in one dialog; screens stay on

- Status: Accepted (2026-10-25)
- Date: 2026-10-25
- Amends: ADR 0058 §1 (a desktop starts the first time it is needed and stays on; only memory pressure parks one), §6 (no terminal view; its backend goes in a later change) and §13 (one dialog in the apps); ADR 0056 §10 (the ready time, when the wait began, the ready email, no pairing with external provisioning, no approval step)
- Builds on: ADR 0025 (connected computers), ADR 0040 (the agent browser), ADR 0057 (system mode), ADR 0059 (AI accounts), ADR 0062 (desktop computer use)

## Context

People saw an agent's computer as three cards (its browser, its desktop, its terminal), turned its desktop on and off, and waited for the workspace's own computer with a step but no time. Most of them aren't developers: a terminal means nothing to them, and on a computer that is always on, "off" and "turns on when needed" only confuse. The workspace's own computer takes seconds when a ready one is handed over and about ten minutes when one is made from nothing; a wait that long needs the time left, and a way to leave the page without missing the end.

## Decision

### 1. One entry and one dialog per agent

- Each agent has one entry, "Desk's computer": a status line and one button (Open, or Help when the agent asks this person), on its page, in its DM header and on its computer's page. Open shows its computer in a dialog: watch, take control, hand back, full screen.
- A computer with screens shows the agent's screen, where its browser is a window; one without (a Mac) shows the agent's page. Whoever helps with a browser request gets the page, never the whole screen.
- No terminal view: in control, the screen's own Terminal app is there for whoever wants it. The terminal's backend (`/api/terminal`, the runner's terminal and its switch) goes in a later change; the machine protocol stays 21, since those fields were optional.
- `?computer=1` opens the dialog; `?browser=1`, `?desktop=1` and `?terminal=1` keep working for older links. The links the server makes (`agentBrowserLink`: the desktop app's tray, notifications) say `?computer=1`.

### 2. A screen starts the first time it is needed, then stays on

- An agent's screen starts the first time it is needed: its first screen or browser command, or the first time someone opens it (1.3 s on a 4-CPU, 8 GB computer, creating the agent's OS user included). Nothing stops it for being idle afterwards, so what a person left open on it is still there later. Only the agent's browser window closes after 15 unused minutes, as before, with its sign-ins kept.
- Opening a stream starts a screen that isn't running (`stream.open` runs `ensure`), for a watcher too, except on a paused computer. An older runner answers `desktop_off` instead; the server then sends `desktop.session.start` and opens once more.
- Nothing turns a screen on or off: `POST …/agents/{id}/desktop/start` and the screen's `…/desktop/stop` are gone (the browser's stop stays). `GET …/agents/{id}/desktop` drops `canStart` and `terminal`, and says `held`: the agent is held or its workspace is on hold, so people may watch and nobody takes control.
- Parked only under memory pressure. Before a screen or a headed Chrome starts, the runner reads `MemAvailable` (`/proc/meminfo`). Under 1.5 GiB it parks screens, least recently used first, among those nobody watches, whose agent doesn't use them, and that nothing touched for an hour (an open request touches its screen every 5 minutes); it stops once 1.5 GiB is free, and with nothing left to park it refuses `desktop_busy`. A parked screen starts again like a first time. This replaces the count of desktops per machine (7 on 8 GB); the 50 display slots stay. Without `/proc/meminfo` there are no screens, and the browser keeps its count.

On an 8 GB computer (7.8 GB visible, 2 GiB of it kept for the system and the AI command-line tools) a screen takes 0.15–0.19 GB idle, and its browser about 0.6 GB more while open:

| Agents | Their screens, always on | Left for open browsers | Browsers open at once |
| --- | --- | --- | --- |
| 3 | 0.6 GB | 5.2 GB | all 3 |
| 10 | 1.9 GB | 3.9 GB | 6 |
| 20 | 3.8 GB | 2.0 GB | 3; a 4th parks screens untouched for an hour |
| about 30 | 5.7 GB | none | the least used are parked, and start again when needed |

- The agents' tools: `computer_start` and `computer_stop` are offered only for a Daytona sandbox; on any other computer `computer_status` says where the agent is, and that the workspace's own computer is always on.

### 3. The wait: a ready time, and the seconds left

- The provisioner reports `expectedReadyAt` with `preparing` (`PUT /orgs/{orgId}/provisioning`, ISO, at most 7 days ahead). A time already past means any moment now, and never replaces a stored time that is past too: while the last part runs over its estimate, the provisioner resends the time of sending every 30 s, and the apps tell "almost ready" from "a little longer" by how long ago the first one was. An older provisioner's `etaSeconds` reads as that many seconds from now, and its `reason: approval` as `capacity`: there is no approval step.
- `machine_provisioning` gains `expected_ready_at`, `requested_at` and `email_when_ready`; `eta_seconds` goes, with the pending times copied. `requested_at` is when people started waiting: written only when the computer is taken away, kept by every later report, and read as the workspace's creation when null, so making a workspace writes nothing.
- `GET …/computer-setup` and `machine.provisioning` add `requestedAt`, `expectedReadyAt`, `secondsLeft` (counted by the server when it answers, so a wrong clock on someone's device doesn't matter) and `notifyByEmail` (the server sends email).
- Taking the computer away (`DELETE …/machines/{machineId}`) leaves a `preparing` row from that moment instead of none, so the next wait counts from it.

### 4. The ready email

- When the workspace's computer becomes ready, its owners get one email each in their language (one per language group), once per ready (the notification's key, `computer_ready:{machineId}:{readyAt}`), through the email outbox. Only from a server that sends email, and only when a report had promised it (a ready time over a minute ahead, `waiting` or `problem`: `email_when_ready`) or the wait took over a minute. A ready computer handed over in seconds sends none.
- It says what the computer is (its size, when known, and a user of its own for each agent), and numbers the next steps it shows: connect an AI (only while no agent has one), give a first task in #general (create an agent instead, when there is none), and watch them work from an agent's page.

### 5. No pairing with external provisioning

With `MACHINE_PROVISIONING=external` every workspace has its own computer, so people connect none: `POST /api/machines/device` and `POST …/organizations/{orgId}/machines/device/{userCode}/confirm` answer 403 `machine.pairing_off`, and a runner pointed at the server stops at once instead of showing a code nobody can confirm. The workspace's own computer never asks for a code: it redeems the one it was issued at `POST /api/machines/device/token`.

### 6. Words by edition

The apps read the edition from `computer-setup`'s `mode` (`external` or `pair`), never from `/api/health`. With external provisioning nothing names an "off", turning on or off, "your computer", pairing or "the cloud"; "always on" is the one power word. On a self-hosted server the computers are "This server's computer" and "Other computers". A test keeps the list of keys each edition shows and the words they may not use.

## Consequences

- Memory, not a count, decides how many screens run. A busy 8 GB computer with many agents browsing at once may close what was left open on its least-used screens.
- What a person left on a screen lasts until the computer restarts: a reboot ends the screens, and each starts again at its next use.
- Older runners keep working: the server starts their screen before opening it. Older provisioners keep working too, and one that sends times gets the overrun right.
- People on a server with external provisioning can't bring a computer of their own.
