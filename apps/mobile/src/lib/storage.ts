import * as SecureStore from "expo-secure-store";
import { STORAGE_PREFIX } from "@/config";

/**
 * Small values the app remembers (theme, current organization, push token), in SecureStore.
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
} as const;

export async function clearStoredValues(): Promise<void> {
  await Promise.all(Object.values(STORED).map((name) => writeValue(name, null)));
}
