import { useSyncExternalStore } from "react";
import { API_URL, APP_VARIANT } from "@/config";
import { currentServer, savedServer } from "./server-choice";
import { readValueSync, writeValue } from "./storage";

/** Not in `STORED`: signing out of a server doesn't leave it. */
const SERVER = "server";

/** Development builds may use http, on localhost or the local network only. */
export const ALLOW_HTTP = APP_VARIANT === "development";

let server = currentServer(readValueSync(SERVER), API_URL);
const listeners = new Set<() => void>();

/** The server the app talks to, read at call time: it changes while the app runs. */
export const serverUrl = () => server;

/** The server, for what must follow a change (the providers). */
export function useServer() {
  return useSyncExternalStore(subscribe, serverUrl);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Points the app at `next`; callers sign out of the current server first (`connectToServer`). */
export async function setServer(next: string) {
  server = next;
  await writeValue(SERVER, savedServer(next, API_URL));
  for (const listener of listeners) listener();
}
