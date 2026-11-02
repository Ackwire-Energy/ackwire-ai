import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { authedFetch } from "./auth";
import { createHolder, deviceBody, devicePath, quietWhileOpen, readPushData, systemToken } from "./push-payload";
import { serverUrl } from "./server";
import { readValue, STORED, writeValue } from "./storage";

/**
 * Push notifications (ADR 0035 §4, ADR 0123). The system's prompt comes only after our sheet on Conversas
 * (`features/push`, `@agenteschat/client/lib/push-offer`) or the switch in Você; the app registers its push token
 * with the server, and removes it on sign-out. Android registers the phone's own FCM token (the server sends to
 * Firebase directly); the iPhone registers an Expo push token.
 */

/** A conversation on screen: a channel or a DM, or one of its threads. */
export interface OpenConversation {
  orgId: string;
  channelId: string;
  threadId?: string | null;
}

/** The conversation on screen (the chat screen holds it while focused). */
const openConversation = createHolder<OpenConversation>();

/** This screen's conversation is on screen; the returned release clears it only if no other screen took over. */
export const holdOpenConversation = (open: OpenConversation) => openConversation.hold(open);

/** The conversation on screen now, if any. */
export const openConversationNow = () => openConversation.get();

/**
 * The island draws what arrives while the app is open (ADR 0071 §9): set while it is up, with the socket live. The
 * system's banner then stays away, so nothing shows twice; with the socket down the banner is still there.
 */
let islandLive = false;
export const setIslandLive = (live: boolean) => {
  islandLive = live;
};

/**
 * Notifications shown while the app is open: the island's, or else a banner with no sound; nothing for the
 * conversation on screen.
 */
export function configureForegroundPush() {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const quiet =
        islandLive || quietWhileOpen(readPushData(notification.request.content.data), openConversation.get());
      return { shouldShowBanner: !quiet, shouldShowList: !quiet, shouldPlaySound: false, shouldSetBadge: false };
    },
  });
}

export async function ensureAndroidChannel(name: string, description: string) {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name,
    description,
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => {});
}

export type PushPermission = "granted" | "denied" | "undetermined";

export async function pushPermission(): Promise<PushPermission> {
  try {
    const s = await Notifications.getPermissionsAsync();
    return s.granted ? "granted" : s.canAskAgain ? "undetermined" : "denied";
  } catch {
    return "denied";
  }
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

interface Registration {
  ask: boolean;
  locale: string;
  /** The new token a token listener got (the listener must not ask the system for it again). */
  token?: string;
}

/** Registrations run one at a time: asking the system for the token may also fire the token listener. */
let queue: Promise<unknown> = Promise.resolve();

/** How long a registration waits for the server: one that doesn't answer must not hold the ones queued after it. */
const REGISTER_WAIT_MS = 15_000;

/**
 * Registers this phone for pushes. With `ask`, shows the system prompt when not decided yet; without
 * it, only registers when permission is already granted. Returns whether a token was registered.
 */
export function registerForPush(registration: Registration): Promise<boolean> {
  const run = queue.then(() => register(registration));
  queue = run.catch(() => {});
  return run;
}

/** This phone's push token: Android's FCM token from the system, the iPhone's Expo push token. */
async function phoneToken(): Promise<string | null> {
  try {
    if (Platform.OS === "android") return systemToken(await Notifications.getDevicePushTokenAsync());
    const id = projectId();
    return (await Notifications.getExpoPushTokenAsync(id ? { projectId: id } : undefined)).data;
  } catch {
    return null;
  }
}

async function register({ ask, locale, token: given }: Registration): Promise<boolean> {
  if (!Device.isDevice) return false;
  // The listener's token is the one just registered (asking the system for it fired the listener): done.
  if (given && (await readValue(STORED.pushToken)) === given) return true;
  // Turned off while this one waited in the queue: registering now would turn it back on.
  if (!ask && (await pushTurnedOff())) return false;
  let permission = await pushPermission();
  if (permission === "undetermined" && ask) {
    await writeValue(STORED.pushAsked, "1");
    const s = await Notifications.requestPermissionsAsync().catch(() => null);
    permission = s?.granted ? "granted" : "denied";
  }
  if (permission !== "granted") return false;
  const token = given ?? (await phoneToken());
  if (!token) return false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REGISTER_WAIT_MS);
  const res = await authedFetch(`${serverUrl()}/api/app/push/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(deviceBody(token, Platform.OS, locale)),
    signal: abort.signal,
  }).catch(() => null);
  clearTimeout(timer);
  if (!res?.ok) return false;
  // A token this phone registered before (the system rolled it, or an Expo token from an older Android build) is
  // forgotten on the server, so pushes don't go to a token nothing answers.
  const previous = await readValue(STORED.pushToken);
  await writeValue(STORED.pushToken, token);
  await writeValue(STORED.pushOff, null);
  if (previous && previous !== token) await forgetToken(previous);
  return true;
}

/**
 * On Android, registers again whenever FCM gives the app a new token while it runs, unless the person turned
 * notifications off. Returns the unsubscribe. (The iPhone's Expo token stays the same when Apple's changes.)
 */
export function watchPushToken(locale: () => string): () => void {
  if (Platform.OS !== "android") return () => {};
  try {
    const sub = Notifications.addPushTokenListener((next) => {
      const token = systemToken(next);
      if (!token) return;
      void (async () => {
        if (await pushTurnedOff()) return;
        if ((await pushPermission()) !== "granted") return;
        await registerForPush({ ask: false, locale: locale(), token });
      })();
    });
    return () => sub.remove();
  } catch {
    // No native module (tests).
    return () => {};
  }
}

/** Whether the person turned notifications off in the app. */
export const pushTurnedOff = async () => (await readValue(STORED.pushOff)) === "1";

/** How long signing out waits for each answer: a server that doesn't answer must not hold the phone. */
export const SIGN_OUT_WAIT_MS = 5000;

/** Deletes a token from the server, waiting at most `SIGN_OUT_WAIT_MS`. Never throws. */
async function forgetToken(token: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SIGN_OUT_WAIT_MS);
  await authedFetch(`${serverUrl()}${devicePath(token)}`, { method: "DELETE", signal: abort.signal }).catch(() => null);
  clearTimeout(timer);
}

/**
 * Removes this phone's token from the server. Never throws. By default this is the person turning
 * notifications off (remembered, so the app doesn't register again on its own); sign-out passes
 * `{ optOut: false }` (it forgets everything anyway).
 */
export async function unregisterPush({ optOut = true }: { optOut?: boolean } = {}): Promise<void> {
  if (optOut) await writeValue(STORED.pushOff, "1");
  const token = await readValue(STORED.pushToken);
  if (!token) return;
  await forgetToken(token);
  await writeValue(STORED.pushToken, null);
}
