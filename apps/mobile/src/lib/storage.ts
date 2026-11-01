import * as SecureStore from "expo-secure-store";
import { STORAGE_PREFIX } from "@/config";

/**
 * Small values the app remembers (theme, current organization, push token, collapsed sections), in SecureStore.
 * Reads never throw: a missing or unreadable value is `null`.
 */
const key = (name: string) => `${STORAGE_PREFIX}.${name}`;

export async function readValue(name: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key(name));
  } catch {
    return null;
  }
}

export function readValueSync(name: string): string | null {
  try {
    return SecureStore.getItem(key(name));
  } catch {
    return null;
  }
}

export async function writeValue(name: string, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key(name));
    else await SecureStore.setItemAsync(key(name), value);
  } catch {
    // Storage unavailable: the app works without remembering.
  }
}

/** Names of the remembered values (one place, so sign-out can clear them all). */
export const STORED = {
  theme: "theme",
  org: "org",
  pushToken: "push-token",
  pushAsked: "push-asked",
  /** The person turned notifications off in the app (no silent re-registration). */
  pushOff: "push-off",
  /** How many times our notifications sheet opened by itself (@agenteschat/client/lib/push-offer). */
  pushOffers: "push-offers",
  /** Conversas' sections the person collapsed (JSON list). */
  homeCollapsed: "home-collapsed",
  /** The Threads tab's sections the person collapsed (JSON list). */
  threadsCollapsed: "threads-collapsed",
  /** Agentes' groups the person collapsed, in every workspace (JSON list of group ids). */
  agentGroupsCollapsed: "agent-groups-collapsed",
  /** An invitation opened before signing in: dealt with once the person is in (features/auth/invite.ts). */
  invite: "invite",
  /** The request this phone made through a link, with the key that signs in once approved (features/auth/invite.ts). */
  joinAsked: "join-asked",
  /** The app's sounds on this phone: "tactile" (default), "sky", "pixel" or "off" (lib/sounds.ts). */
  sounds: "sounds",
  /** Offline-computer notices the person closed, by outage (JSON list; features/outages). */
  outagesDismissed: "outages-dismissed",
  /** The last conversation opened in each workspace (JSON by workspace id): "Onde você parou" (ADR 0108). */
  lastPlace: "last-place",
} as const;

export async function clearStoredValues(): Promise<void> {
  await Promise.all(Object.values(STORED).map((name) => writeValue(name, null)));
}
