import type { TFunction } from "i18next";
import type { AgentComputer, ComputerSetup, ComputerSetupStep, Edition, Machine } from "../api/types";
import { type ComputerState, computerKind } from "./machines";

/** What a person asked the agent's PC to do. */
export type ComputerAction = "start" | "stop" | "remove";

/** What the chip shows: the server's status, or ours while an action runs. */
export type ComputerDisplay = AgentComputer["status"] | "starting" | "stopping" | "removing";

/** Poll `GET …/computer` this often while an action runs (until the `agent.computer` event says it's done). */
export const POLL_MS = 2000;
/** The elapsed seconds appear after this. */
export const ELAPSED_AFTER_MS = 3000;
/** "Criando a máquina" → "Preparando o ambiente" after this. */
export const PREPARE_AFTER_MS = 4000;
/** "Pronto" stays this long before the step line goes away. */
export const READY_FLASH_MS = 1500;
/** Past this, say it's taking too long (and stop waiting). */
export const GIVE_UP_MS = 180_000;

const TARGET: Record<ComputerAction, AgentComputer["status"][]> = {
  start: ["running"],
  stop: ["stopped", "archived"],
  remove: ["none"],
};

/** The server reached what the action wanted. */
export const reached = (action: ComputerAction, status: string | undefined) =>
  status !== undefined && (TARGET[action] as string[]).includes(status);

export const busyDisplay: Record<ComputerAction, ComputerDisplay> = {
  start: "starting",
  stop: "stopping",
  remove: "removing",
};

export type StartStep = "creating" | "booting" | "preparing" | "ready";

export interface BusyView {
  /** Start only: the step line. */
  step: StartStep | null;
  /** Whole seconds since the click, once past `ELAPSED_AFTER_MS`. */
  elapsed: number | null;
  /** Past `GIVE_UP_MS`. */
  tooLong: boolean;
}

/**
 * The progress shown while an action runs, from the click time and now (pure,
 * so tests pass a fake clock). `fresh`: the PC didn't exist yet.
 */
export function busyView(action: ComputerAction, sinceMs: number, nowMs: number, fresh: boolean): BusyView {
  const ms = Math.max(0, nowMs - sinceMs);
  return {
    step: action === "start" ? (ms < PREPARE_AFTER_MS ? (fresh ? "creating" : "booting") : "preparing") : null,
    elapsed: ms >= ELAPSED_AFTER_MS ? Math.floor(ms / 1000) : null,
    tooLong: ms >= GIVE_UP_MS,
  };
}

// ── The workspace's own computer (ADR 0056 §10) ─────────────────────────────

/**
 * Which words the computers get: the Cloud's where a provisioner prepares each workspace's own computer
 * (`computer-setup` says `external`), self-host's where people connect theirs (`pair`). Null while loading:
 * no edition's words show then. `/api/health`'s edition isn't it: the Cloud runs the self-host image.
 */
export const computerEdition = (setup: ComputerSetup | null | undefined): Edition | null =>
  setup ? (setup.mode === "external" ? "cloud" : "selfhost") : null;

/** The provisioner's steps, in order (`computerSetup.step.*`). */
export const SETUP_STEPS: readonly ComputerSetupStep[] = ["reserving", "starting", "installing", "connecting"];

export type SetupPhase = "preparing" | "waiting" | "problem" | "ready";
/** What a line or a chip says: the phase, or why it waits. */
type SetupStatus = Exclude<SetupPhase, "waiting"> | "capacity";

/** The workspace's own computer as every screen says it (onboarding, notice, Computers, the agent's page, phone). */
export interface SetupView {
  phase: SetupPhase;
  /** While preparing: the step, and its number from 1 (0 before the provisioner names one). */
  step: ComputerSetupStep | null;
  stepNumber: number;
  /** While waiting: `capacity` (longer than usual). */
  reason: "capacity" | null;
  /** The status line. */
  textKey: `computerSetup.step.${ComputerSetupStep}` | `computerSetup.status.${SetupStatus}`;
  /** The short word for a chip. */
  chipKey: `computerSetup.chip.${SetupStatus}`;
  /** `computerSetup.specs`'s values ("4 CPUs · 8 GB…"), once the provisioner said. */
  specs: ComputerSetup["specs"];
  /** The computer itself, once made (its page). */
  machineId: string | null;
  /** The server's seconds left when its answer came (`receivedAt`, this device's clock); null: no time said. */
  secondsLeft: number | null;
  receivedAt: number;
  /** Seconds people had waited when the server answered, on the server's clock; null when it doesn't say. */
  waited: number | null;
  /** The server sends email (`promisesEmail`). */
  notifyByEmail: boolean;
}

/**
 * Null where people connect their own computers (`pair`), or before the server answers: nothing to show.
 * `receivedAt`: when the answer came, on this device's clock (the time left counts down from it).
 */
export function setupView(setup: ComputerSetup | null | undefined, receivedAt = Date.now()): SetupView | null {
  if (setup?.mode !== "external") return null;
  const phase: SetupPhase = setup.state ?? "preparing";
  const step = phase === "preparing" && setup.step && SETUP_STEPS.includes(setup.step) ? setup.step : null;
  // Every wait reads as capacity: an older server's `approval` too.
  const status: SetupStatus = phase === "waiting" ? "capacity" : phase;
  const secondsLeft = typeof setup.secondsLeft === "number" ? setup.secondsLeft : null;
  // The server's clock at its answer: exact from its own two numbers, else this device's.
  const serverNow =
    secondsLeft !== null && setup.expectedReadyAt ? Date.parse(setup.expectedReadyAt) - secondsLeft * 1000 : receivedAt;
  const requested = setup.requestedAt ? Date.parse(setup.requestedAt) : Number.NaN;
  return {
    phase,
    step,
    stepNumber: step ? SETUP_STEPS.indexOf(step) + 1 : 0,
    reason: phase === "waiting" ? "capacity" : null,
    textKey: step ? `computerSetup.step.${step}` : `computerSetup.status.${status}`,
    chipKey: `computerSetup.chip.${status}`,
    specs: setup.specs,
    machineId: setup.machineId,
    secondsLeft,
    receivedAt,
    waited: Number.isNaN(requested) || Number.isNaN(serverNow) ? null : Math.max(0, (serverNow - requested) / 1000),
    notifyByEmail: setup.notifyByEmail === true,
  };
}

/** The time left as the preparing screens say it (`computerSetup.eta.*`). */
export type EtaView =
  | { kind: "minutes"; count: number }
  | { kind: "underMinute" }
  | { kind: "almost" }
  | { kind: "late" };

/**
 * The time left now: the server's `secondsLeft` less the seconds since its answer came. A minute or more:
 * whole minutes, rounded up; under 15 s, or up to a minute past the time: almost; past that: a little longer
 * than expected. Null without a time.
 */
export function etaView(secondsLeft: number | null, receivedAtMs: number, nowMs: number): EtaView | null {
  if (secondsLeft === null) return null;
  const left = secondsLeft - Math.max(0, nowMs - receivedAtMs) / 1000;
  if (left >= 60) return { kind: "minutes", count: Math.ceil(left / 60) };
  if (left >= 15) return { kind: "underMinute" };
  if (left >= -60) return { kind: "almost" };
  return { kind: "late" };
}

/** "About 6 min left", "Almost ready…" (`computerSetup.eta.*`). */
export const etaLine = (t: TFunction, eta: EtaView) =>
  eta.kind === "minutes" ? t("computerSetup.eta.minutes", { count: eta.count }) : t(`computerSetup.eta.${eta.kind}`);

/** Only while it is being prepared: a wait and a problem have no time. */
export const setupEta = (view: SetupView, nowMs: number) =>
  view.phase === "preparing" ? etaView(view.secondsLeft, view.receivedAt, nowMs) : null;

/** How often the time line repaints: every 15 s, every 5 s under a minute. No ticking seconds. */
export const etaTickMs = (eta: EtaView | null) => (eta?.kind === "minutes" ? 15_000 : 5_000);

/**
 * Whether "we'll email you" holds: the server sends email, and the wait is or will be over a minute, which
 * is when it emails the owners once the computer is ready: more than a minute left when it answered,
 * waiting or a problem, or a minute gone since people started waiting (with no time said, only that).
 */
export function promisesEmail(view: SetupView, nowMs: number): boolean {
  if (!view.notifyByEmail || view.phase === "ready") return false;
  if (view.phase === "waiting" || view.phase === "problem") return true;
  if (view.secondsLeft !== null && view.secondsLeft > 60) return true;
  return view.waited !== null && view.waited + Math.max(0, nowMs - view.receivedAt) / 1000 > 60;
}

/**
 * What the setup query keeps when an answer arrives: one asked before a `machine.provisioning` event and back
 * after it never undoes that event (`since`, when the state began, only moves forward while the workspace keeps
 * its computer).
 */
export function newerSetup(cached: ComputerSetup | undefined, fetched: ComputerSetup): ComputerSetup {
  if (!cached?.since || !fetched.since) return fetched;
  return Date.parse(fetched.since) < Date.parse(cached.since) ? cached : fetched;
}

/** The portrait: lit once ready and online, dimmed while on its way, dark when stuck or offline. */
export function setupPortrait(view: SetupView, online: boolean): ComputerState {
  if (view.phase === "ready") return online ? "online" : "offline";
  return view.phase === "problem" ? "offline" : "paused";
}

/** Not ready yet: the notice, the waiting agents and the onboarding's progress show. */
export const setupPending = (view: SetupView | null): view is SetupView => view !== null && view.phase !== "ready";

/**
 * The agents waiting for the workspace's computer: those no computer lists. Its first hello gives it to every
 * agent without one (ADR 0056 §10).
 */
export function agentsWaitingForComputer<A extends { id: string }>(
  agents: readonly A[],
  machines: readonly Pick<Machine, "agents">[],
): A[] {
  const placed = new Set(machines.flatMap((m) => m.agents.map((a) => a.id)));
  return agents.filter((a) => !placed.has(a.id));
}

/** What a closed notice remembers: the same state stays closed, a new state (or step) shows again. */
export const setupNoticeKey = (orgId: string, view: SetupView) =>
  `${orgId}:${view.phase}:${view.step ?? view.reason ?? ""}`;

/**
 * The workspace's own computer's portrait, before and after it exists: a server (its OS reads `other`), never
 * the cloud computer an agent may get of its own.
 */
export const WORKSPACE_COMPUTER_KIND = computerKind("other");

export type NoComputer = "cloud" | "workspace" | "none";

/**
 * What an agent's "no computer" choice (`machineId` null) stands for in a picker: `workspace` while the
 * workspace's own computer is on its way (the agents with none get it); `cloud`, a Daytona sandbox, where this
 * server has them; else `none`, shown only for an agent that has none (picking it would leave an agent with
 * no computer). Null: not offered.
 */
export function noComputerChoice(view: SetupView | null, cloudAvailable: boolean, current: boolean): NoComputer | null {
  if (setupPending(view)) return "workspace";
  if (cloudAvailable) return "cloud";
  return current ? "none" : null;
}
