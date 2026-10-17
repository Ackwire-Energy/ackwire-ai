# agentes (phone app)

Expo + React Native app for agentes.chat (ADR 0035, D50). Flows and look: `docs/design/telas/Mobile.html`.

**Nothing runs on a developer's machine.** Code is checked in CI (`.github/workflows/ci.yml`: lint, typecheck,
unit tests of the pure logic in `apps/mobile/test`). Builds and installs go through EAS
(`.github/workflows/mobile.yml`).

## Get a build on a phone (EAS only)

1. One time, on expo.dev: create an access token (Account settings → Access tokens). The EAS project
   already exists; its ID is in `app.config.ts` (`EAS_PROJECT_ID` overrides it).
2. In GitHub → Settings → Secrets and variables → Actions: secret `EXPO_TOKEN` = the access token.
3. Run the workflow **Mobile build (EAS)** (Actions → Run workflow), profile `preview`, platform `all`.
   Pull requests that touch `apps/mobile/**` also build `preview` when the secret exists.
4. Open the build on expo.dev from the phone:
   - Android: the `preview` profile makes an APK; install it from the link.
   - iOS: `preview` is an internal (ad hoc) build. Register the iPhone once on expo.dev
     (Devices → Register, a link to open on the phone), then build again. iOS builds need an Apple
     Developer account connected to EAS (credentials are managed by EAS on the first build).
5. `development` builds include the dev client; `production` builds go to the stores (`eas submit`).

## Environment

Set per profile in `eas.json` (`build.<profile>.env`) or on expo.dev (EAS environment variables):

| Variable | What | Default |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | The backend. **Must be the server's `PUBLIC_URL` host** (see below). | `https://agentes.chat` |
| `EAS_PROJECT_ID` | EAS project, for push tokens. | ours (`8514d5b3-…`) |
| `APP_VARIANT` | `development` / `preview` / `production`: name and bundle id suffix, so all three install side by side. | `production` |

Why the API URL must equal the public URL: React Native's WebSocket adds an `Origin` derived from the URL
(`wss://host` → `https://host`). The server accepts a request without `Origin` that carries
`X-Agentes-Client: mobile`, and refuses a foreign `Origin` even with the header. So the app's host must be the
one the server considers its own.

Server side (not in this folder): Better Auth's Expo plugin trusts `agenteschat://`; Sign in with Apple needs
`APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, and the native iOS button sends an ID
token whose audience is the bundle id `chat.agentes.app` (the server's Apple provider must accept it).

## How it fits together

- `app/_layout.tsx`: providers + the session gate (signed out → `app/(auth)`, signed in with an organization →
  `app/(app)`). `app/(auth)`: sign in, sign up, forgot password.
- `src/providers`: theme, i18n (`@agenteschat/i18n` + `src/i18n/keys.*.ts` under `mobile.*`), React Query, API
  (`useApi()` from `@agenteschat/client`), session (`useSession`), organization (`useOrg`), realtime
  (`useRealtime` → `{ connection, status }`), push (`usePush().ask()`), fonts.
- `src/lib`: auth client (session cookie in SecureStore), API client, WebSocket factory, push registration.
- `src/ui`: the design system for React Native (`import { … } from "@/ui"`).
- `src/agent`: agents drawn by the single engine (`@agenteschat/ui/agent/engine`) through a recorder + Skia
  replay (`recorder.ts`, `skia-ctx.ts`); one shared ~25 fps clock.
- `src/sky`: sky, fuse, spend bar and plan track as Skia shaders; `math.ts` mirrors the shader and is tested
  against the web's math (`@agenteschat/ui/sky/math`).

## Fonts

`assets/fonts` holds static instances from Google Fonts (all SIL Open Font License, texts in `OFL-*.txt`):
Onest 400/500/600/700, Funnel Display Light (large titles) and Doto at ROND 100, weight 600 (every count).
React Native has no variable-font axes, so each is a separate file; the family names are the keys in
`src/ui/theme.tsx` (`fonts`). To refresh them, request the same instances from
`https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=Funnel+Display:wght@300&family=Doto:ROND,wght@100,600`
without a browser user agent (it then serves `.ttf`).

## Images

`assets/images/*.png` are placeholders generated from the agent engine's shape and dither (icon 1024, Android
adaptive foreground 1024, splash 512, notification 96 white silhouette). Replace them with the final art at the
same sizes.

## React versions in the workspace

React Native's renderer needs the exact React it was built with (SDK 58: `react@19.3.0`), while the web may
resolve a newer patch at the root. `metro.config.js` resolves `react` and `react-native` from this folder for
every package, so the app bundle has a single React. Hierarchical lookup stays on (Bun's hoisted layout nests
conflicting versions under the packages that need them).
