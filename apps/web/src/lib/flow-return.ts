import { sessionStore } from "@/lib/storage";

/** How long a saved flow waits for its way back. */
const FLOW_RETURN_TTL = 60 * 60 * 1000;
/** The address parameter that marks the way back into a flow. */
export const FLOW_RETURN_PARAM = "resume";

interface Saved<T> {
  org: string;
  at: number;
  draft: T;
}

/**
 * A stepped flow whose draft lives in memory, kept while a sign-in on another site (connecting an app, GitHub for a
 * skill) reloads the app: saved in this tab under `key` before leaving, taken once on the way back.
 */
export function flowReturn<T>(key: string) {
  const forget = () => sessionStore.remove(key);
  return {
    /** The path the other site comes back to: this page, marked, with `extra` to read on arrival. */
    path(extra: Record<string, string> = {}) {
      const search = new URLSearchParams({ [FLOW_RETURN_PARAM]: "1", ...extra });
      return `${window.location.pathname}?${search}`;
    },
    save(org: string, draft: T) {
      sessionStore.set(key, JSON.stringify({ org, at: Date.now(), draft } satisfies Saved<T>));
    },
    forget,
    /**
     * The draft, when this page is the way back and it was saved for this workspace within the hour, with the
     * address's other parameters (the server's `connected`, ours); the address is cleaned either way.
     */
    take(org: string): { draft: T; params: Record<string, string> } | null {
      if (typeof window === "undefined") return null;
      const url = new URL(window.location.href);
      if (!url.searchParams.has(FLOW_RETURN_PARAM)) return null;
      const params = Object.fromEntries(url.searchParams);
      delete params[FLOW_RETURN_PARAM];
      window.history.replaceState(window.history.state, "", url.pathname + url.hash);
      let saved: Saved<T> | null = null;
      try {
        saved = JSON.parse(sessionStore.get(key) ?? "null") as Saved<T> | null;
      } catch {
        saved = null;
      }
      forget();
      if (!saved || saved.org !== org || Date.now() - saved.at > FLOW_RETURN_TTL) return null;
      return { draft: saved.draft, params };
    },
  };
}
