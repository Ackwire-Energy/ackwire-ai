# 0165. Pairing a computer from the desktop app, Cloud included

- Status: Accepted
- Date: 2026-11-09
- Supersedes: ADR 0066 §3 ("a link never pairs this computer") and §4/§5 (agentes.chat is a plain client, agents
  here only for your own server), for the devices people bring
- Extends: ADR 0025 (connected computers), ADR 0036 (desktop app), ADR 0066 (one desktop app)
- Code: engine `device-links.ts` (`connectLinkInfo`); server `routes/devices.ts` (`registerConnectLinkInfo`,
  `GET /api/machines/connect-links/{code}`); client `lib/server.ts` (`pairLink`), `lib/devices.ts` (`newComputerOf`);
  web `components/devices/ConnectDialog.tsx`, `components/ThisMac.tsx`; phone
  `features/devices/ConnectScreen.tsx`; desktop `main_window.rs` (`agents_here`), the `agenteschat://pair` handler and
  its confirm, Preferences › This Mac; runner control `pair.start` with `link` (`packages/adapters/src/runner-control.ts`)

## Context

ADR 0066 made agentes.chat a plain client in the desktop app: every Cloud workspace had a computer of its own, so the
app never paired the computer it runs on there, and a link could never pair it. Since then people bring their own
computers and phones to every workspace, the Cloud included, through a line pasted in a terminal (`curl … | sh`,
a connect link that works once for 10 minutes and only asks to join). That is fine for a server and hard for everyone
else, while the app already pairs this computer in one click behind the system's own Allow dialog, only not on Cloud.

## Decision

1. **Agents here on Cloud too.** `agents_here(origin, server_here)` drops its agentes.chat exclusion: the app may pair
   this computer with any server, except one on this computer itself (a loopback address, the server the app runs
   here), which is set up with it already. The site's `useAgentsHere` follows the app's answer, so "This computer"
   in the connect dialog is the one-click button on Cloud as on a self-hosted server.
2. **The app's own ways in.** After sign-in, once per workspace with no home here, a card asks "Let {{org}}'s agents
   use this {{device}}?" with who can use it and Open at login; Allow pairs it (the card is the ask), Not now is
   remembered. Preferences › This Mac lists every workspace the person is signed in to with a switch each. Pairing
   from the app turns on Open at login unless the person unchecks it: agents of a brought computer work while the app
   runs.
3. **A link may pair this computer, after the person confirms in the app.** `agenteschat://pair?server=<origin>&link=<code>`
   (`pairLink`): `server` validated as `agenteschat://connect`'s, `link` a connect link's code with or without its
   dash, any case. The app never pairs from it without asking: its own confirm names the workspace, who made the
   link, the server and this computer, with Not now and Connect. Connect asks to join with the link (`pair.start`
   with `link`, posting `/api/machines/device` as `agentes-runner pair --link` does), and the link's maker still lets
   it in on the web, with its name and who can use it. The app never confirms a link's device code itself. Anything
   invalid is ignored; unknown parameters too.
4. **What the confirm reads.** `GET /api/machines/connect-links/{code}`, with no session and no CSRF (it only reads):
   `{ org: { name }, by: { name }, kind, expiresAt }` while the link waits for its computer, and the same
   `404 { "error": "link_expired" }` for a code that is unknown, used or expired, so a guess learns nothing about which.
   Codes stay hashed at rest and are looked up by hash, as `/i/{code}` does, with the same limit per address (30 a
   minute).
5. **The web's connect dialog** offers This computer, Another computer and A server or VPS on every setup. This
   computer in a browser makes a connect link (kind computer) and offers "Open the agentes.chat app" (the link above)
   for as long as it waits, with the downloads for after installing, the waiting line, today's join card, and one
   line for a terminal as the way out. Only where the app takes such a link (`appPairsWith`: https, not on this
   computer); a page served over plain http or from this computer itself offers the one line, as before. Another
   computer lists the app's steps and waits, live, for a computer of the
   person's that wasn't in the devices list when the dialog opened (the list and its events, no new endpoint), then
   says "Connected: {{name}}" with its page; one line for a terminal stays the way out. A server's flow is unchanged.
6. **The phone** offers this phone, another computer through its app (the same steps and live wait, no button to
   open the app, which a phone can't do for another computer) and a server or VPS.

## Consequences

- A person brings a computer to a Cloud workspace without a terminal: the app, an Allow, and it is theirs.
- A link from the web reaches only the app's confirm, and the maker's approval is still the gate: a link that leaks
  joins nothing by itself, and a person who didn't ask chooses Not now.
- The link info endpoint names a workspace and a person to whoever holds a live code; codes are short-lived,
  single-use and rate-limited per address.
- An app built before this still refuses Cloud and doesn't know `agenteschat://pair`: the web keeps the terminal line
  as the way out there.
