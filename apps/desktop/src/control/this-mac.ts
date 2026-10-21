/**
 * The site in the app's main window asks this Mac three things (D79), relayed by Rust (`this_mac` in
 * main_window.rs, which already checked the request): which organizations it is connected to, connecting it
 * to one, and Preferences on a tab. The popover answers, since it owns the runners. Connecting starts the
 * same sign-in as the welcome window, but the site confirms the code with its own session instead of the
 * person reading it in the browser; the machine's token stays with the runner.
 */

import { ControlError } from "./client";
import { type DesktopStore, type Home, isPairedHome, isRefusedHome, pairedHomes } from "./store";
import { SITE_URL } from "./version";

export type ThisMacRequest =
  | { kind: "status" }
  | { kind: "connect"; orgId: string }
  | { kind: "prefs"; tab: "folders" | "tools" };

export interface ThisMacStatus {
  orgs: { orgId: string; machineId: string | null; connection: string }[];
}

/** `userCode`: the site confirms it (`/machines/device/{code}/confirm`); null when already connected. */
export interface ThisMacConnect {
  userCode: string | null;
}

export interface ThisMacDeps {
  store: DesktopStore;
  /** Preferences on a tab (the popover's own "Preferências…"). */
  openPrefs(tab: "folders" | "tools"): Promise<void>;
  /** How long to wait for the runner's code. */
  codeTimeoutMs?: number;
}

const orgOf = (h: Home) => h.status?.org?.id;

export function thisMacStatus(store: DesktopStore): ThisMacStatus {
  return {
    orgs: pairedHomes(store.getSnapshot()).flatMap((h) => {
      const orgId = orgOf(h);
      return orgId
        ? [{ orgId, machineId: h.status?.machine?.id ?? null, connection: h.status?.connection ?? "offline" }]
        : [];
    }),
  };
}

export async function answerThisMac(deps: ThisMacDeps, request: ThisMacRequest): Promise<unknown> {
  if (request.kind === "status") return thisMacStatus(deps.store);
  if (request.kind === "prefs") {
    await deps.openPrefs(request.tab);
    return {};
  }
  return connect(deps, request.orgId);
}

async function connect({ store, codeTimeoutMs = 20_000 }: ThisMacDeps, orgId: string): Promise<ThisMacConnect> {
  const homes = store.getSnapshot().homes;
  const same = homes.filter((h) => isPairedHome(h) && orgOf(h) === orgId);
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
    await store.request(homeId, { type: "pair.start", server: SITE_URL });
  } catch (err) {
    if (err instanceof ControlError && err.code === "already_paired") return { userCode: null };
    throw err;
  }
  return { userCode: await code };
}

/**
 * Once the site confirmed: the new organization gets the tools the others have (they are for the whole
 * computer), as when the welcome window adds one. The first one starts with none; the person turns them on
 * in Preferences → Ferramentas.
 */
function whenPaired(store: DesktopStore, homeId: string) {
  const off = store.onEvent((id, event) => {
    if (id !== homeId || (event.kind !== "pair.done" && event.kind !== "pair.failed")) return;
    off();
    if (event.kind === "pair.failed") return;
    void (async () => {
      await store.refresh(homeId);
      const base = pairedHomes(store.getSnapshot()).find((h) => h.homeId !== homeId)?.access?.tools;
      if (!base) return;
      for (const tool of ["claude", "codex", "commands"] as const) {
        await store.request(homeId, { type: "tools.set", tool, on: base[tool] }).catch(() => {});
      }
    })();
  });
  // A code nobody confirms expires; stop listening well after.
  setTimeout(off, 30 * 60_000);
}
