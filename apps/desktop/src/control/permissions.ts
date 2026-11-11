/**
 * The macOS permissions agents need on this computer (ADR 0165 "Prepare this Mac"): Screen Recording, for the
 * screenshots their commands take, and the Desktop, Documents and Downloads folders. The app asks for them and its
 * runners inherit them. macOS only says whether the screen is allowed without asking; a folder is only read once it was
 * asked for in this version of the app (the read itself raises the prompt), and an ad-hoc signed app loses every grant
 * when it updates.
 */
import type { Host } from "../host/types";

export const MAC_PERMISSIONS = ["screen", "desktop", "documents", "downloads"] as const;
export type MacPermission = (typeof MAC_PERMISSIONS)[number];
export type MacFolder = Exclude<MacPermission, "screen">;

/** `ask`: not asked in this version yet (Allow asks); `off`: asked and not allowed (the way out is System Settings). */
export type Grant = "on" | "off" | "ask";
export type Grants = Record<MacPermission, Grant>;

/** The permissions asked for in a version of the app. */
export const MAC_ASKED_PREF = "macAsked";
export interface Asked {
  version: string;
  asked: MacPermission[];
}

export const askedIn = (saved: Asked | null, version: string): MacPermission[] =>
  saved?.version === version ? saved.asked : [];

export const withAsked = (saved: Asked | null, version: string, p: MacPermission): Asked => {
  const asked = askedIn(saved, version);
  return { version, asked: asked.includes(p) ? asked : [...asked, p] };
};

/** Each permission's state, without raising a prompt. */
export async function readGrants(host: Host, asked: readonly MacPermission[]): Promise<Grants> {
  const screen = await host.screenAccess();
  const folder = async (f: MacFolder): Promise<Grant> =>
    !asked.includes(f) ? "ask" : (await host.folderAccess(f)) ? "on" : "off";
  const [desktop, documents, downloads] = await Promise.all([
    folder("desktop"),
    folder("documents"),
    folder("downloads"),
  ]);
  return { screen: screen ? "on" : asked.includes("screen") ? "off" : "ask", desktop, documents, downloads };
}

export const allOn = (grants: Grants) => MAC_PERMISSIONS.every((p) => grants[p] === "on");

/**
 * A setup macOS may quit the app in the middle of (Screen Recording's "Quit & Reopen"), kept in the app's data folder
 * (`prepare.rs`) so the app reopens it: the pairing window's Prepare step for `org`, or Preferences. `resumed`: the
 * app reopened it at launch.
 */
export type SetupState = ({ step: "prepare"; org: string; server: string } | { step: "prefs" }) & {
  resumed?: boolean;
};

/** The site's This computer paired it: the welcome window takes this once and shows the Prepare step. */
export const PREPARE_PREF = "prepare";
