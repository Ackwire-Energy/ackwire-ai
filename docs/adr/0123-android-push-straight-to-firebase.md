# 0123. Android push straight to Firebase

- Status: Accepted
- Date: 2026-11-02
- Amends: 0035 §4 (phone pushes went through the Expo Push API on both platforms)
- Code: `packages/adapters/src/push-fcm.ts` (`createFcmPushSender`, `fcmMessage`), `push.ts`
  (`createPhonePushSender`, `PushMessage.platform`); `packages/config/src/pem.ts` (`parseFirebaseServiceAccount`),
  `schema.ts` (`FIREBASE_SERVICE_ACCOUNT`); `packages/engine/src/push.ts` (`FCM_PUSH_TOKEN`, per-phone failures in
  `deliverPush`); `apps/server/src/routes/app/push.ts`, `start.ts`; `apps/mobile/src/lib/push.ts`
  (`getDevicePushTokenAsync`, `watchPushToken`), `push-payload.ts` (`systemToken`), `src/providers/push.tsx`

## Context

ADR 0035 sent every phone push through the Expo Push API: the app registered an Expo push token, and Expo forwarded
each message to Firebase Cloud Messaging (Android) or APNs (iPhone). That puts a third party between the server and
the phone that sees each push's text and token, needs the Firebase key uploaded to Expo, and is one more service a
self-hosted install depends on. On Android nothing about it is needed: the app already shows notifications with
expo-notifications, which runs its own Firebase messaging service on the phone.

## Decision

1. **Android pushes go from the server straight to FCM's HTTP v1 API.** The server holds a service account of the
   Firebase project the Android app is built with (`FIREBASE_SERVICE_ACCOUNT`: the JSON key, or base64 of it). It
   signs a JWT (RS256), trades it at Google's token endpoint for an access token (shared by every send until five
   minutes before it expires; a 401 gets one new token and one more try), and sends one `messages:send` request per
   message, ten at a time. Without the variable, Android phones stay registered and get no push.
2. **The message is a data message laid out the way expo-notifications presents it**: `title`, `message`, `body` (the
   deep link data as JSON, ADR 0035 §4), `channelId` (`default`, the channel the app creates) and `sound`. No
   `notification` block, so the app's own service gets it in every state; no `collapse_key` (FCM keeps four per
   phone, so a phone that was away would lose pushes). Priority `HIGH` for what waits on the person, else `NORMAL`;
   a day's TTL.
3. **The app registers the phone's own FCM token** (`getDevicePushTokenAsync`), and registers again when FCM hands
   it a new one while it runs (`addPushTokenListener`). A token the phone registered before is deleted on the server
   once the new one is in. The route takes an FCM token for `android` and an Expo token for `ios`, each refusing the
   other's.
4. **One `PushSender` for phones** (`createPhonePushSender`) sends each message to its platform's sender and keeps
   the results in order. FCM answers per message: a gone token (404, `UNREGISTERED`, `SENDER_ID_MISMATCH`, a
   malformed token) is deleted; 429, 5xx and the network are retryable; the rest is final. `deliverPush` counts those
   per-phone failures, and the outbox tries the job again only when nothing was sent and every failure can be retried,
   so a phone is never pushed twice.
5. **iPhones are unchanged for now**: Expo push tokens through the Expo Push API, with receipts. They move to APNs
   the same way in a later change.

## Consequences

- No third party between the server and an Android phone but Google's own push service; the Firebase key lives only
  on the server.
- The store app's Firebase project is agentes.chat's, so a self-hosted server can't push to the store app on Android:
  it needs its own build and Firebase project, or a relay, which is not part of this change.
- Builds made before this change register Expo tokens on Android, which the route now refuses; they never got Android
  pushes (no Firebase in the build), so nothing that worked stops.
