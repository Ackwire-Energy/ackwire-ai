/**
 * The site in the app's main window asks this computer a few things, relayed by Rust (`this_mac` in
 * main_window.rs, which checked the request and added the asking page's own `origin` and whether agents
 * may work here for it, `agentsHere`): which of its organizations this computer works for, pairing it with
 * one, reconnecting it, Preferences on a tab, the access requests (the popover), and on the server here the
 * folder of its files (Storage's "Show the folder"). The popover answers, since it owns the runners. Pairing
 * starts the device-code sign-in with the page's own server; the site confirms the code with its own session
 * and the machine's token stays with the runner. Rust already asked the person (the system's own dialog)
 * before a `connect` gets here.
 */

import type { RunnerTools } from "@agenteschat/adapters/machine-protocol";
import { ControlError } from "./client";
import { filesFolder } from "./local-server";
import { homeServer } from "./server";
import {
  type DesktopStore,
  type Home,
  isPairedHome,
  isRefusedHome,
  isUnpairedHome,
  orgName,
  pairedHomes,
} from "./store";

/**
 * `local`: the asking page is the server here (`local_server.rs`), whose own homes point at its loopback
 * address, `also`, whichever address the page has.
 */
export type ThisMacRequest =
  | { kind: "status"; origin: string; agentsHere: boolean; local?: boolean; also?: string }
  | { kind: "connect"; orgId: string; origin: string; agentsHere: boolean; local?: boolean; also?: string }
  | { kind: "reconnect"; orgId: string; origin: string; local?: boolean; also?: string }
  | { kind: "prefs"; tab: PrefsTab }
  | { kind: "requests" }
  | { kind: "files"; local?: boolean };

export type PrefsTab = "folders" | "tools" | "updates";

export interface ThisMacStatus {
  orgs: { orgId: string; machineId: string | null; connection: string }[];
  /** Whether agents may work on this computer for this server (false: the site hides "This Mac"). */
  agentsHere: boolean;
  /** The page is the server this app runs here (its sign-in offers "Continue on this Mac"). */
  local: boolean;
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
  /** The server here's folder (`~/.agentes`), as the app runs it now. */
  localDir(): Promise<string>;
  /** A folder of this computer in Finder or the file manager; rejects when it isn't one. */
  revealFolder(path: string): Promise<void>;
  /** How long to wait for the runner's code. */
  codeTimeoutMs?: number;
  /** The site confirmed a pairing it asked for: its agents work while the app runs, so it opens at login. */
  onPaired?(): void;
}

const orgOf = (h: Home) => h.status?.org?.id;

/** The homes paired with `origin`, or with `also` (the server here's loopback address); never another server's. */
const homesOf = (store: DesktopStore, origin: string, also?: string) =>
  pairedHomes(store.getSnapshot()).filter((h) => {
    const server = homeServer(h);
    return server === origin || (!!also && server === also);
  });

export function thisMacStatus(
  store: DesktopStore,
  origin: string,
  agentsHere: boolean,
  local = false,
  also?: string,
): ThisMacStatus {
  return {
    orgs: homesOf(store, origin, also).flatMap((h) => {
      const orgId = orgOf(h);
      return orgId
        ? [{ orgId, machineId: h.status?.machine?.id ?? null, connection: h.status?.connection ?? "offline" }]
        : [];
    }),
    agentsHere,
    local,
  };
}

export async function answerThisMac(deps: ThisMacDeps, request: ThisMacRequest): Promise<unknown> {
  if (request.kind === "status")
    return thisMacStatus(deps.store, request.origin, request.agentsHere, request.local === true, request.also);
  if (request.kind === "prefs") {
    await deps.openPrefs(request.tab);
    return {};
  }
  if (request.kind === "requests") {
    await deps.showRequests();
    return {};
  }
  if (request.kind === "files") {
    // A folder of this computer, only for the page of the server it keeps.
    if (request.local !== true) throw new Error("not_here");
    const dir = await deps.localDir();
    // The server makes `files` with the first upload: until then, its own folder.
    await deps.revealFolder(filesFolder(dir)).catch(() => deps.revealFolder(dir));
    return {};
  }
  if (request.kind === "reconnect") {
    // The socket again (as the popover's "Reconnect"). Refused by the organization: pairing again is `connect`.
    const home = homesOf(deps.store, request.origin, request.also).find(
      (h) => orgOf(h) === request.orgId && !isRefusedHome(h),
    );
    if (!home) throw new Error("not_connected");
    await deps.store.request(home.homeId, { type: "reconnect" });
    return {};
  }
  if (!request.agentsHere) throw new Error("not_here");
  return connect(deps, request.orgId, request.origin);
}

/**
 * Starts the runner's device-code sign-in with `origin` for `orgId` and resolves with its code, which whoever pairs
 * confirms with their session (the site, or the app's own windows through `site_fetch`); null when already connected.
 */
export async function connect(
  { store, codeTimeoutMs = 20_000, onPaired }: Pick<ThisMacDeps, "store" | "codeTimeoutMs" | "onPaired">,
  orgId: string,
  origin: string,
): Promise<ThisMacConnect> {
  const homes = store.getSnapshot().homes;
  const same = homes.filter((h) => isPairedHome(h) && orgOf(h) === orgId && homeServer(h) === origin);
  if (same.some((h) => !isRefusedHome(h))) return { userCode: null };
  // Refused by this organization: its own home, so it comes back as the same computer. Else a home left
  // unpaired by an earlier try, or a new one.
  const homeId = same[0]?.homeId ?? homes.find(isUnpairedHome)?.homeId ?? (await store.addHome());

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
  void whenPaired(store, homeId, onPaired);
  try {
    await store.request(homeId, { type: "pair.start", server: origin });
  } catch (err) {
    if (err instanceof ControlError && err.code === "already_paired") return { userCode: null };
    throw err;
  }
  return { userCode: await code };
}

/**
 * A new organization's tools on this computer: the ones the others have (they are for the whole computer);
 * the first one starts with the browser on, Claude Code and Codex on when found here. Commands always start off:
 * a page asked for this pairing, and the system's dialog promised it; only Preferences › Tools turns them on.
 */
export async function firstTools(store: DesktopStore, homeId: string) {
  await store.refresh(homeId);
  const snap = store.getSnapshot();
  const found = snap.homes.find((h) => h.homeId === homeId)?.status?.executors ?? {};
  const others = pairedHomes(snap).find((h) => h.homeId !== homeId)?.access?.tools ?? {
    claude: !!found.claude,
    codex: !!found.codex,
    commands: false,
    browser: true,
  };
  const base = { ...others, commands: false };
  for (const tool of ["claude", "codex", "commands", "browser"] as const) {
    await store.request(homeId, { type: "tools.set", tool, on: !!base[tool] }).catch(() => {});
  }
}

/**
 * The tools as Preferences › Tools shows them, one switch each for every organization here. Commands may be on
 * for some only (a new organization starts without them): the switch is on when all have them, and
 * `commandsOnlyFor` names the organizations that do while others don't.
 */
export function toolsHere(homes: readonly Home[]): { tools: RunnerTools; commandsOnlyFor: string[] } {
  const known = homes.filter((h) => h.access);
  const tools = known[0]?.access?.tools ?? { claude: false, codex: false, commands: false, browser: false };
  const withCommands = known.filter((h) => h.access?.tools.commands);
  const all = known.length > 0 && withCommands.length === known.length;
  return { tools: { ...tools, commands: all }, commandsOnlyFor: all ? [] : withCommands.map(orgName) };
}

/** Once the pairing is confirmed, the new organization's first tools, then `onDone`. */
export function whenPaired(store: DesktopStore, homeId: string, onDone?: () => void) {
  const off = store.onEvent((id, event) => {
    if (id !== homeId || (event.kind !== "pair.done" && event.kind !== "pair.failed")) return;
    off();
    if (event.kind !== "pair.done") return;
    void firstTools(store, homeId);
    onDone?.();
  });
  // A code nobody confirms expires; stop listening well after.
  setTimeout(off, 30 * 60_000);
}

/**
 * A home the server here's sync made (`host://new`): once its runner says it is signed in, its first tools.
 * Gives up after `timeoutMs` (its runner never came up; the next sync doesn't call it new again).
 */
export function whenHostHomeReady(store: DesktopStore, homeId: string, timeoutMs = 60_000) {
  const ready = () => store.home(homeId)?.status?.paired === true;
  if (ready()) {
    void firstTools(store, homeId);
    return;
  }
  const timer = setTimeout(() => off(), timeoutMs);
  const off = store.subscribe(() => {
    if (!ready()) return;
    clearTimeout(timer);
    off();
    void firstTools(store, homeId);
  });
}
