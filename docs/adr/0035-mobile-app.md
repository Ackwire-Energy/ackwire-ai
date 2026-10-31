# 0035. Mobile app: Expo + React Native with shared logic

- Status: Accepted
- Date: 2026-10-17
- Extends: ADR 0007 (keys never reach clients), the in-app notifications (`packages/engine/src/notifications.ts`)

## Context

We want a phone app with the same identity and behavior as the web. Today all client logic (API types and client, TanStack queries, realtime, i18n, formatting and domain helpers) lives inside `apps/web`. The private API (`/api/app/*`) assumes a browser: a same-origin cookie session, and a CSRF check that refuses state-changing requests whose `Origin` is not ours. A native app sends no `Origin`. There is no push, no in-app account deletion and no Sign in with Apple, all of which the stores require.

## Decision

**1. Expo + React Native in `apps/mobile`. Logic is shared, UI is not.**
- Screens and components are native (Expo Router, `View`/`Text`) and follow the same design system. No react-native-web or universal UI kit.
- Verification runs in CI (lint, typecheck, unit tests on pure logic). Builds and device installs go through EAS (`.github/workflows/mobile.yml`, needs the `EXPO_TOKEN` secret).

**2. Shared packages.** The web imports them too and must not change behavior.
- `@agenteschat/client` (`packages/client`): API types, `ApiError`, the HTTP client, query keys, query options and the React Query hooks, realtime (`RealtimeConnection`, frames, streams, consultations), and the DOM-free helpers from `apps/web/src/lib`. React is allowed (hooks run on both platforms). DOM, `react-dom`, `window`, `document`, `localStorage` and `@agenteschat/ui` are not, and a guard test enforces this. Platform effects come in as options (for example `onAgentReaction` instead of calling `playAgentReaction`).
  - `createHttpApi({ baseUrl?, fetch?, headers? })`: `baseUrl` defaults to same origin; `headers` is a function called per request and merged into every request, JSON and files alike.
  - `realtimeUrl(base: string | { protocol: string; host: string }, orgId)` and `RealtimeConnection({ url, createSocket, ... })`, where `createSocket` is injected (the app passes a factory that adds headers).
  - Subpath exports: `@agenteschat/client` (root: api, types, keys, queries, realtime) and `@agenteschat/client/lib/<name>` for each moved helper.
- `@agenteschat/i18n` (`packages/i18n`): `ptBR`, `en`, `type Translations`, and `resources` (i18next shape, one namespace). It keeps the parity guard.
- `@agenteschat/tokens` (`packages/tokens`): `light` and `dark` color maps with the CSS variable names in camelCase (`bg`, `raised`, `sunken`, `glass`, `line`, `line2`, `ink`, `ink2`, `muted`, `faint`, `agent`, `agent2`, `ok`, `warn`, `danger`, …), `shadows` (`e1`, `e2`, `e3` as layer lists `{ x, y, blur, spread, color }`), `radius`, `fonts` (`sans` Onest, `display` Funnel Display, `dot` Doto) and `motion` (bezier curves, spring). `docs/design/design-system/tokens.css` stays the source of truth, and a test keeps the TS values equal to it.
- The agent engine stays single. `@agenteschat/ui` exports `./agent/engine` (the existing `engine.js`) and the DOM-free sky math. The app draws through a small adapter from the engine's `Ctx2D` subset to React Native Skia. The sky and the fuse in the app are a Skia shader whose output a test compares against the shared math.

**3. App sessions without browser CSRF.**
- The server adds Better Auth's Expo plugin (`@better-auth/expo`) and trusts the app scheme `agenteschat://`. The app signs in with `expoClient` (session in SecureStore, social sign-in through the system browser and a deep link back).
- The plugin's `/api/auth/expo-authorization-proxy`, where that browser starts, would redirect to any https address and sign that address's `state` into the visitor's state cookie (an open redirect, and a way to plant someone else's sign-in). It only goes on to a configured provider's authorization endpoint (Google, GitHub, Apple) with our client id and our own callback as `redirect_uri`; anything else is a 400 (`expoProxyAllowed` in `apps/server/src/auth.ts`).
- The app calls `/api/app/*` and `/api/ws` with the session cookie read from SecureStore (`authClient.getCookie()`) in a `Cookie` header, plus `X-Agentes-Client: mobile`, and no `Origin`.
- The CSRF rule in `routes/app/context.ts` becomes: with an `Origin`, it must be one of ours (unchanged). Without an `Origin`, the request must carry `X-Agentes-Client: mobile`. A browser cannot send that custom header cross-site without a CORS preflight, and we never allow one. Plain HTML forms always send an `Origin`. The WebSocket upgrade follows the same rule.
- React Native's WebSocket sends an `Origin` derived from the URL. It passes because the app's API URL is the server's `PUBLIC_URL`; a foreign `Origin` is refused even with the app header.
- Nothing new reaches the client: provider keys and MCP stay server-side (ADR 0007).

**4. Push notifications.**
- `push_devices` (migration 0066; per user, not per org: `user_id`, `token`, `platform` ios|android, `locale`, timestamps) with `POST /api/app/push/devices` (upsert, 204; the token moves to whoever is signed in; 10 devices per person, 30 registrations an hour) and `DELETE /api/app/push/devices/:token` (204, own tokens only).
- Delivery goes through the outbox as a `push.send` job, via a `PushSender` adapter (Expo Push API; a fake in tests). Unregistered tokens are removed.
- What pushes (notification kinds): everything in "Esperando você" (approval, agent question, forum turn), mention, DM from a person, an agent's answer to the person behind its run (ADR 0071 §7), and mission or routine stopped or failed. Muted or read items do not push. Grouped items push once per group while unread.
- Push text is the one exception to "server strings in English": the OS shows it as is. A small catalog (`push-messages.ts`, pt-BR and en, picked by the device locale) renders it. The payload carries `{ orgId, kind, notificationId, channelId?, threadId?, approvalId?, missionId? }` for the deep link.
- A high-risk approval is never approved from the notification. It opens the app, which asks to hold.

**5. Store requirements.**
- `DELETE /api/app/account` deletes the person's account (App Store 5.1.1(v)). It returns 204, or 409 `sole_owner` (with `params.organizations`) while they are the only owner of an organization that has other members, and the app says what to do. Organizations where they are the only member are deleted with them; their messages stay without an author.
- Sign in with Apple is a social provider when `APPLE_CLIENT_ID`/`APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` are set, and `authConfig` lists it (App Store 4.8, required because we offer Google).
- The app sells nothing. Plans are bought on the web.

- Push receipts: each send that got tickets schedules a `push.receipts` job about 15 minutes later; it asks Expo (`/--/api/v2/push/getReceipts`) and deletes the tokens whose receipt says `DeviceNotRegistered`.
- Deleting an account that signed in with Apple revokes its Apple token (`https://appleid.apple.com/auth/revoke`, the refresh token when Better Auth kept one, else the access token), best effort, after the account is gone, with a client secret signed for the call.

**Known gaps (follow-ups):** the Apple client secret used for sign-in is signed at boot and lasts 150 days, so the server must restart within that window. A native iOS sign-in (id token only) stores no Apple token, so there is nothing to revoke for it.

## Consequences

- One place for API contracts, translations and tokens, so web and app cannot drift.
- The CSRF change widens `/api/app` to non-browser clients carrying a valid session. Sessions from the app show up in the session list and can be revoked.
- The app has two drawing paths for the sky (Canvas on the web, a shader in the app), held together by a test.
- `apps/mobile` brings React Native into the workspace install. CI installs it but tests only its pure logic. Builds run on EAS.
