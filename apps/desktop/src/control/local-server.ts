/**
 * The server here ("Run agentes.chat on this computer") as the windows see it: `local_server.rs` keeps it and
 * says how it is; this decides what each window shows (the first run's steps and screens, the popover's
 * banners, the cover's line, Preferences' words). Pure, so it is tested without the app.
 */

export type LocalPhase = "off" | "starting" | "updating" | "running" | "stopped" | "failing";

export interface LocalServerStatus {
  /** This build carries the server (Mac and Linux builds do). */
  bundled: boolean;
  /** What `~/.agentes` holds: the app's own server, or one installed from the terminal. */
  installed: "none" | "app" | "terminal";
  /** The app runs it (it starts with the app). */
  run: boolean;
  /** Its owner's account exists. */
  owner: boolean;
  phase: LocalPhase;
  /** Its loopback address. */
  url: string | null;
  /** Its address for people: the Tailscale one with reach on. */
  publicUrl: string | null;
  reach: boolean;
  /** Usage statistics on (`TELEMETRY`). */
  usage: boolean;
  version: string | null;
  dir: string;
  /** The person's name on this computer (the welcome window only). */
  systemName: string | null;
  /** A terminal install still waiting for its owner: its claim (the welcome window only). */
  claim: string | null;
  /** An update didn't start and it went back to this version. */
  backTo: string | null;
}

export type Tailnet = { state: "missing" } | { state: "off" } | { state: "on"; device: string };
export type ServeProblem = { reason: "https"; url: string | null } | { reason: "operator" } | { reason: "serve" };
export type ReachResult = { ok: true; url: string } | { ok: false; problem: ServeProblem };

export interface LocalChoice {
  name?: string;
  email?: string;
  reach: boolean;
  usage: boolean;
}

export type SetupStep = "database" | "start" | "account" | "computer" | "reach";
export type StepState = "todo" | "active" | "done" | "failed" | "warn";
export interface StepChange {
  step: SetupStep;
  state: Exclude<StepState, "todo">;
  reason?: ServeProblem;
}

/** Nothing set up yet, not running: how the windows start before the app answers. */
export const NO_SERVER: LocalServerStatus = {
  bundled: false,
  installed: "none",
  run: false,
  owner: false,
  phase: "off",
  url: null,
  publicUrl: null,
  reach: false,
  usage: true,
  version: null,
  dir: "~/.agentes",
  systemName: null,
  claim: null,
  backTo: null,
};

/** "Setting it up", in order; access from other devices only when it was asked for. */
export const setupSteps = (reach: boolean): SetupStep[] => [
  "database",
  "start",
  "account",
  "computer",
  ...(reach ? (["reach"] as const) : []),
];

/** Each step's state from the changes that arrived; a step not heard of yet is still to do. */
export function stepStates(steps: readonly SetupStep[], changes: readonly StepChange[]): Record<SetupStep, StepState> {
  const out = Object.fromEntries(steps.map((s) => [s, "todo"])) as Record<SetupStep, StepState>;
  for (const c of changes) if (c.step in out) out[c.step] = c.state;
  return out;
}

/** What "Run agentes.chat on this computer" shows. */
export type HereView =
  /** The form; `ask`: the owner's name and email (no owner yet). */
  | { kind: "form"; ask: boolean }
  /** One already runs on this computer, installed from the terminal: use it (its owner page while it waits). */
  | { kind: "already"; server: string; claim: string | null };

/**
 * `answering`: an agentes.chat server that answered on this computer's loopback (Connect's discovery), when the
 * app doesn't run one itself.
 */
export function hereView(status: LocalServerStatus, answering: string | null): HereView {
  if (status.installed === "terminal" && status.url)
    return { kind: "already", server: status.url, claim: status.claim };
  if (status.installed !== "app" && answering) return { kind: "already", server: answering, claim: null };
  return { kind: "form", ask: !(status.installed === "app" && status.owner) };
}

/** Why reach didn't turn on, in `desktop.here.reason.*`'s words. */
export const REASON_TEXT: Record<ServeProblem["reason"], string> = {
  https: "desktop.here.reason.https",
  operator: "desktop.here.reason.operator",
  serve: "desktop.here.reason.serve",
};

/** The server here in a few words: "Running · only on this Mac", "Starting", … */
export function hereLine(status: LocalServerStatus): string {
  switch (status.phase) {
    case "running":
      return status.reach ? "desktop.server.onTailnet" : "desktop.server.onlyHere";
    case "starting":
      return "desktop.server.starting";
    case "updating":
      return "desktop.server.updating";
    case "failing":
      return "desktop.server.failing";
    default:
      return "desktop.server.stopped";
  }
}

/** The popover's banner about the server here: stopped (Start it), not starting (diagnostics), or an update that went back. */
export function hereBanner(status: LocalServerStatus): "stopped" | "failing" | "back" | null {
  if (!status.run) return null;
  if (status.phase === "failing") return "failing";
  if (status.phase === "stopped") return "stopped";
  return status.backTo ? "back" : null;
}

/** Whether `server` is the server here, at either of its addresses. */
export const isHereServer = (status: LocalServerStatus, server: string | null) =>
  status.run && !!server && (server === status.url || server === status.publicUrl);

/**
 * The main window's cover over the server here: starting, updating, stopped, not starting, or running at its
 * Tailscale address while Tailscale isn't connected on this computer (`reachable`: that address answered).
 */
export function coverHere(
  status: LocalServerStatus,
  current: string | null,
  reachable: boolean,
): "starting" | "migrating" | "stopped" | "failing" | "tailnetOff" | null {
  if (!isHereServer(status, current)) return null;
  if (status.phase === "starting") return "starting";
  if (status.phase === "updating") return "migrating";
  if (status.phase === "failing") return "failing";
  if (status.phase !== "running") return "stopped";
  return status.reach && current === status.publicUrl && !reachable ? "tailnetOff" : null;
}
