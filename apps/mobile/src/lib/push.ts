import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { API_URL } from "@/config";
import { authedFetch } from "./auth";
import { deviceBody, devicePath, quietWhileOpen, readPushData } from "./push-payload";
import { readValue, STORED, writeValue } from "./storage";

/**
 * Push notifications (ADR 0035 §4). The app asks for permission after sign-in at a calm moment (never on
 * the first screen), registers the Expo push token with the server, and removes it on sign-out.
 */

/** The conversation on screen (the chat screen sets it while focused). */
let openConversation: { orgId: string; channelId: string } | null = null;

export function setOpenConversation(open: { orgId: string; channelId: string } | null) {
  openConversation = open;
}

/** Notifications shown while the app is open: a banner, no sound; nothing for the conversation on screen. */
export function configureForegroundPush() {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const quiet = quietWhileOpen(readPushData(notification.request.content.data), openConversation);
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

/**
 * Registers this phone for pushes. With `ask`, shows the system prompt when not decided yet; without
 * it, only registers when permission is already granted. Returns whether a token was registered.
 */
export async function registerForPush({ ask, locale }: { ask: boolean; locale: string }): Promise<boolean> {
  if (!Device.isDevice) return false;
  let permission = await pushPermission();
  if (permission === "undetermined" && ask) {
    await writeValue(STORED.pushAsked, "1");
    const s = await Notifications.requestPermissionsAsync().catch(() => null);
    permission = s?.granted ? "granted" : "denied";
  }
  if (permission !== "granted") return false;
  const id = projectId();
  const token = await Notifications.getExpoPushTokenAsync(id ? { projectId: id } : undefined)
    .then((r) => r.data)
    .catch(() => null);
  if (!token) return false;
  const res = await authedFetch(`${API_URL}/api/app/push/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(deviceBody(token, Platform.OS, locale)),
  }).catch(() => null);
  if (!res?.ok) return false;
  await writeValue(STORED.pushToken, token);
  await writeValue(STORED.pushOff, null);
  return true;
}

/** Whether the app already asked for permission once (so it never nags). */
export const alreadyAskedForPush = async () => (await readValue(STORED.pushAsked)) === "1";

/** Whether the person turned notifications off in the app. */
export const pushTurnedOff = async () => (await readValue(STORED.pushOff)) === "1";

/**
 * Removes this phone's token from the server. Never throws. By default this is the person turning
 * notifications off (remembered, so the app doesn't register again on its own); sign-out passes
 * `{ optOut: false }` (it forgets everything anyway).
 */
export async function unregisterPush({ optOut = true }: { optOut?: boolean } = {}): Promise<void> {
  if (optOut) await writeValue(STORED.pushOff, "1");
  const token = await readValue(STORED.pushToken);
  if (!token) return;
  await authedFetch(`${API_URL}${devicePath(token)}`, { method: "DELETE" }).catch(() => null);
  await writeValue(STORED.pushToken, null);
}
