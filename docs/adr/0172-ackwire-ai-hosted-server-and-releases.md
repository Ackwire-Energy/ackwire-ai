# 0172 — Ackwire AI's own hosted server and release channel

Date: 2026-11-13

Status: Accepted

## Context

The apps were renamed Ackwire AI but still pointed at the upstream service. The desktop
and phone apps opened `https://app.agentes.chat` by default, the desktop app checked that
server for updates and trusted the upstream updater key, and a server without builds of
its own offered the upstream desktop app on `/download`. An Ackwire AI build therefore
opened someone else's workspace service, and the download page of Ackwire's server handed
out an app with another name and look.

## Decision

- The hosted server the apps know by name ("Ackwire AI", `CLOUD_SERVER` in
  `packages/client/src/lib/server.ts`, `CLOUD` in `apps/desktop/src-tauri/src/servers.rs`)
  is `https://hub.ackwire.app`. It is the default server of the phone app
  (`EXPO_PUBLIC_API_URL`), the first run of the desktop app, the main window's capability
  and the server the download page falls back to for the newest build.
- The desktop app updates from `https://hub.ackwire.app/api/desktop/update` and trusts
  Ackwire's own updater key (`plugins.updater.pubkey` in `tauri.conf.json`). The private
  half lives only in the repository's `TAURI_SIGNING_PRIVATE_KEY` secret. An app built with
  the upstream key never takes an Ackwire update, and the reverse.
- Desktop releases are this repository's (`DESKTOP_RELEASES_REPO` defaults to
  `Ackwire-Energy/ackwire-ai`), published by the Desktop workflow. The server still needs
  `DESKTOP_RELEASES_TOKEN` to read them.
- "Source code" on the About screens leads to this repository (`SOURCE_URL`,
  `PUBLIC_SOURCE_URL`): AGPL-3.0 section 13 asks a modified version to offer its own source.

Kept as upstream, on purpose: package scopes, storage keys, the `agenteschat://` scheme, the
application identifiers (`chat.agentes.desktop`, `chat.agentes.app`), the build file names
(`agentes_<version>_…`), the help pages on the public docs site, and what the server treats
as the upstream Cloud (`OFFICIAL_HOSTS` in `packages/config`): `hub.ackwire.app` is a
self-hosted server, with none of the Cloud's billing or limits.

## Consequences

- An app installed from the upstream service keeps following it. People install the Ackwire
  AI build once; it updates itself from then on.
- Publishing the phone app in the stores needs identifiers of Ackwire's own, a Firebase
  project for Android push and an Apple team: a separate change.
- A change of the hub's address is a new build of both apps.
