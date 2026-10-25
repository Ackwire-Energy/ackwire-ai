/**
 * The site in the app's main window asks this computer a few things, relayed by Rust (`this_mac` in
 * main_window.rs, which checked the request and added the asking page's own `origin` and whether agents
 * may work here for it, `agentsHere`): which of its organizations this computer works for, pairing it with
 * one, reconnecting it, Preferences on a tab, and the access requests (the popover). The popover answers,
 * since it owns the runners. Pairing starts the device-code sign-in with the page's own server; the site
 * confirms the code with its own session and the machine's token stays with the runner. Rust already asked
 * the person (the system's own dialog) before a `connect` gets here.
 */

import { ControlError } from "./client";
import { homeServer } from "./server";
import { type DesktopStore, type Home, isPairedHome, isRefusedHome, pairedHomes } from "./store";

export type ThisMacRequest =
  | { kind: "status"; origin: string; agentsHere: boolean }
  | { kind: "connect"; orgId: string; origin: string; agentsHere: boolean }
  | { kind: "reconnect"; orgId: string; origin: string }
  | { kind: "prefs"; tab: PrefsTab }
  | { kind: "requests" };

export type PrefsTab = "folders" | "tools" | "updates";

export interface ThisMacStatus {
  orgs: { orgId: string; machineId: string | null; connection: string }[];
  /** Whether agents may work on this computer for this server (false: the site hides "This Mac"). */
  agentsHere: boolean;
}

/** `userCode`: the site confirms it (`/machines/device/{code}/confirm`); null when already connected. */
export interface ThisMacConnect {
  userCode: string | null;
}

export interface ThisMacDeps {
  store: DesktopStore;
  /** Preferences on a tab (the popover's own "Preferences…"). */
  openPrefs(tab: PrefsTab): Promise<void>;
  /** The popover, where access requests are answered. */
  showRequests(): Promise<void>;
  /** How long to wait for the runner's code. */
  codeTimeoutMs?: number;
}

const orgOf = (h: Home) => h.status?.org?.id;

/** The homes paired with `origin` (never another server's). */
const homesOf = (store: DesktopStore, origin: string) =>
  pairedHomes(store.getSnapshot()).filter((h) => homeServer(h) === origin);

export function thisMacStatus(store: DesktopStore, origin: string, agentsHere: boolean): ThisMacStatus {
  return {
    orgs: homesOf(store, origin).flatMap((h) => {
      const orgId = orgOf(h);
      return orgId
        ? [{ orgId, machineId: h.status?.machine?.id ?? null, connection: h.status?.connection ?? "offline" }]
        : [];
    }),
    agentsHere,
  };
}

export async function answerThisMac(deps: ThisMacDeps, request: ThisMacRequest): Promise<unknown> {
  if (request.kind === "status") return thisMacStatus(deps.store, request.origin, request.agentsHere);
  if (request.kind === "prefs") {
    await deps.openPrefs(request.tab);
    return {};
  }
  if (request.kind === "requests") {
    await deps.showRequests();
    return {};
  }
  if (request.kind === "reconnect") {
    // The socket again (as the popover's "Reconnect"). Refused by the organization: pairing again is `connect`.
    const home = homesOf(deps.store, request.origin).find((h) => orgOf(h) === request.orgId && !isRefusedHome(h));
    if (!home) throw new Error("not_connected");
    await deps.store.request(home.homeId, { type: "reconnect" });
    return {};
  }
  if (!request.agentsHere) throw new Error("not_here");
  return connect(deps, request.orgId, request.origin);
}

async function connect(
  { store, codeTimeoutMs = 20_000 }: ThisMacDeps,
  orgId: string,
  origin: string,
): Promise<ThisMacConnect> {
  const homes = store.getSnapshot().homes;
  const same = homes.filter((h) => isPairedHome(h) && orgOf(h) === orgId && homeServer(h) === origin);
  if (same.some((h) => !isRefusedHome(h))) return { userCode: null };
  // Refused by this organization: its own home, so it comes back as the same computer. Else a home left
  // unpaired by an earlier try, or a new one.
  const homeId = same[0]?.homeId ?? homes.find((h) => !isPairedHome(h))?.homeId ?? (await store.addHome());

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timeout"));
    }, codeTimeoutMs);
    const off = store.onEvent((id, event) => {
      if (id !== homeId) return;
      if (event.kind === "pair.code") {
        clearTimeout(timer);
        off();
        resolve(event.userCode);
      } else if (event.kind === "pair.failed") {
        clearTimeout(timer);
        off();
        reject(new Error(event.code));
      }
    });
  });
  void whenPaired(store, homeId);
  try {
    await store.request(homeId, { type: "pair.start", server: origin });
  } catch (err) {
    if (err instanceof ControlError && err.code === "already_paired") return { userCode: null };
    throw err;
  }
  return { userCode: await code };
}

/**
 * Once the site confirmed: the new organization gets the tools the others have (they are for the whole
 * computer). The first one starts with the browser on, Claude Code and Codex on when found here, and
 * commands off; more is Preferences › Tools.
 */
function whenPaired(store: DesktopStore, homeId: string) {
  const off = store.onEvent((id, event) => {
    if (id !== homeId || (event.kind !== "pair.done" && event.kind !== "pair.failed")) return;
    off();
    if (event.kind === "pair.failed") return;
    void (async () => {
      await store.refresh(homeId);
      const snap = store.getSnapshot();
      const found = snap.homes.find((h) => h.homeId === homeId)?.status?.executors ?? {};
      const base = pairedHomes(snap).find((h) => h.homeId !== homeId)?.access?.tools ?? {
        claude: !!found.claude,
        codex: !!found.codex,
        commands: false,
        browser: true,
      };
      for (const tool of ["claude", "codex", "commands", "browser"] as const) {
        await store.request(homeId, { type: "tools.set", tool, on: !!base[tool] }).catch(() => {});
      }
    })();
  });
  // A code nobody confirms expires; stop listening well after.
  setTimeout(off, 30 * 60_000);
}
