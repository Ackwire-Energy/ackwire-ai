# 0071. Push in browsers: Web Push with the server's own key

- Status: Proposed
- Date: 2026-10-27
- Code: `packages/adapters/src/web-push.ts`, `packages/engine/src/push.ts`, `packages/engine/src/web-push.ts`, `apps/server/src/routes/app/push.ts`, `apps/web/public/sw.js`, `apps/web/src/lib/web-push.ts`, `apps/web/src/lib/push-open.ts`
- Extends: ADR 0035 §4

## Context

ADR 0035 gave the phone app push through the Expo Push API. Browsers get nothing while the tab is closed. The desktop app already shows its own notifications through its realtime connection while it runs, even with its window closed (ADR 0066), so it doesn't need push. The self-hosted server must keep working with nothing but Postgres and no account anywhere.

Phone push changes (sending straight to Firebase and Apple, a push relay for self-hosted servers, sealed phone pushes, taking phone notifications down when read elsewhere) are left for a later revision of this record.

## Decision

1. **Browsers use Web Push (RFC 8030) with VAPID (RFC 8292).** The server makes its own P-256 key pair the first time it needs one and keeps it in `instance_push`, the private key sealed with the installation's key. `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY` pin a pair; `WEB_PUSH=off` turns it off. No account with any push service is needed: Chrome, Firefox, Edge and Safari accept this standard as it is. The payload is encrypted to the browser (RFC 8291), so the browser's push service sees only ciphertext; browsers always get the full text.
2. **A browser is a push device like a phone.** `push_devices.platform` gains `web`; the subscription's endpoint is the `token` and its keys go in `web_keys`. The same routes register and forget it, and the same rule (`PUSH_KINDS`, `pushWorthy`, once per group) decides what pushes. A 404 or 410 from the push service deletes the subscription, and so do 401 and 403 (the server's key changed); the page subscribes again on its next load. Endpoints on our own network are refused, as for every address a person gives the server. The page's service worker (`/sw.js`) only shows notifications and opens them; it caches nothing.
3. **The page asks once, on a click.** "Notifications in this browser" is a switch in the account menu, next to the theme, the language and the sounds, never as a prompt on load, never inside the desktop app (it has its own), and not in Safari on iPhone or iPad unless the site is installed (the phone app exists). The page refreshes its subscription on each load, so the server keeps it and moves it to whoever is signed in. Signing out forgets it.
4. **A click opens the notification itself.** The push carries the notification's id and its deep link data; a click opens it where the inbox would (`useNotificationOpener`), in an open tab of the app when there is one, else in a new one at the inbox.
5. **No push for what the person is looking at.** A push that isn't waiting on the person waits 45 seconds while they have the app open somewhere, and then goes only if it is still unread. What waits on them (an approval, a question) goes at once. This applies to phones too. While a window of the app is focused, the service worker shows the notification silently and closes it at once: a push that shows nothing makes Safari end the subscription and Chrome show its own notice.
6. **Read in the app, gone from the browser.** What is read, done or snoozed in an open tab closes the browser notifications it still shows for it; a page coming back to the foreground asks `POST /api/app/push/stale` with the ids it shows and takes down what it returns.

## Consequences

- Browser push works on any self-hosted server with no setup and no third party besides the browser's own push service, which can't read it.
- Changing `AGENTES_SECRET` (or the pinned pair) makes a new key: every browser's subscription is refused once, deleted, and made again on the page's next load.
- A browser's notifications aren't taken down while no tab of the app is open; they are the next time one is.
- The desktop app's own notifications aren't taken down when read elsewhere.
- Left for later: phone push without Expo and through a relay for self-hosted servers, sealed phone pushes, clear on read for phones, a manifest so the site installs on iPhone.
