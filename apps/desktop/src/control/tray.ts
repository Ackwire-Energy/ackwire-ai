import type { ControlJob, ControlStatus } from "@agenteschat/adapters/runner-control";

/** The menu bar icon's states (one template image each, src-tauri/icons/tray). */
export type TrayState = "idle" | "working" | "paused" | "offline" | "update";

export interface TrayInput {
  running: boolean;
  status?: ControlStatus | null;
  jobs: readonly ControlJob[];
}

/** A home that is signed in to an organization (unpaired homes are a sign-in in progress). */
export const isPaired = (h: TrayInput) => h.status?.paired === true;

/** Connected and listening for work. */
export const isOnline = (h: TrayInput) => h.running && h.status?.connection === "online";

/**
 * One icon for the whole computer: any organization paused → paused; anything running → working;
 * every organization offline → offline; a newer app → update; else idle.
 */
export function trayStateOf(homes: readonly TrayInput[], updateAvailable: boolean): TrayState {
  const paired = homes.filter(isPaired);
  if (paired.some((h) => h.status?.paused.paused)) return "paused";
  if (paired.some((h) => h.jobs.length > 0)) return "working";
  if (paired.length > 0 && paired.every((h) => !isOnline(h))) return "offline";
  if (updateAvailable) return "update";
  return "idle";
}
