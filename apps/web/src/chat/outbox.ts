import { ApiError } from "@agenteschat/client";
import { useSyncExternalStore } from "react";

/**
 * Messages that could not go out because the connection was down (telas/Mensagens.html, "Internet
 * caiu"): they stay "sai quando a internet voltar" instead of "Não enviada", and go out again on
 * their own when it is back. Keyed by the optimistic copy's `clientId`, for this tab.
 */
const waiting = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

export const outbox = {
  add(clientId: string) {
    if (waiting.has(clientId)) return;
    waiting.add(clientId);
    changed();
  },
  remove(clientId: string) {
    if (waiting.delete(clientId)) changed();
  },
  has: (clientId: string | undefined) => Boolean(clientId && waiting.has(clientId)),
  list: () => [...waiting],
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** This message waits for the connection to come back. */
export function useQueued(clientId: string | undefined) {
  return useSyncExternalStore(
    outbox.subscribe,
    () => outbox.has(clientId),
    () => false,
  );
}

/** The browser says it has no network. */
export const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * A failed send that is the network's fault (no answer from the server at all, or the browser is
 * offline), not the server refusing it: it waits for the connection instead of failing.
 */
export const failedOffline = (error: unknown) => browserOffline() || !(error instanceof ApiError);
