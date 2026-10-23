/**
 * A tab opened before a deploy keeps running the old app: it reads events the new server sends
 * with old code (another agent's answer shown as the agent's raw words). The page's own bundle
 * (`/assets/index-<hash>.js`) is compared with the one the server's index.html names now; once
 * they differ the app is stale, and the next page change loads the new one.
 */

/** How often an open tab asks, besides on focus and after the realtime socket reconnects (a deploy). */
export const VERSION_CHECK_MS = 5 * 60_000;

/** The app's module script in a page's HTML, or null (a dev server, an unexpected page). */
export function entryOf(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/type="module"/.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (src?.includes("/assets/")) return src;
  }
  return null;
}

export interface VersionWatch {
  check(): Promise<void>;
  readonly stale: boolean;
}

export function createVersionWatch(options: {
  /** The bundle this page runs (null: unknown, never stale). */
  loaded: string | null;
  fetchHtml: () => Promise<string>;
  /** Once, when a new version is first seen. */
  onStale: () => void;
}): VersionWatch {
  let stale = false;
  let inFlight: Promise<void> | null = null;
  return {
    get stale() {
      return stale;
    },
    check() {
      if (stale || !options.loaded) return Promise.resolve();
      inFlight ??= options
        .fetchHtml()
        .then((html) => {
          const current = entryOf(html);
          if (!current || current === options.loaded || stale) return;
          stale = true;
          options.onStale();
        })
        // Offline or a deploy in progress: the next check asks again.
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** This page's bundle, as index.html named it. */
export function loadedEntry(doc: Document = document): string | null {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
}

/** The server's index.html now (revalidated: never the browser's cached copy). */
export async function fetchIndexHtml(): Promise<string> {
  const res = await fetch("/index.html", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`index.html: ${res.status}`);
  return res.text();
}

let current: VersionWatch | null = null;

/** The app's watch (main.tsx); `checkAppVersion` asks it from anywhere (the realtime reconnect). */
export function startVersionWatch(watch: VersionWatch) {
  current = watch;
  return watch;
}

export const checkAppVersion = () => current?.check() ?? Promise.resolve();
