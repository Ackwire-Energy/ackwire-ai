import type { TFunction } from "i18next";
import type { AgentComputer, ComputerSetup, ComputerSetupStep, Machine } from "../api/types";
import type { ComputerState } from "./machines";

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

/** The provisioner's steps, in order (`computerSetup.step.*`). */
export const SETUP_STEPS: readonly ComputerSetupStep[] = ["reserving", "starting", "installing", "connecting"];

export type SetupPhase = "preparing" | "waiting" | "problem" | "ready";
/** What a line or a chip says: the phase, or why it waits. */
type SetupStatus = Exclude<SetupPhase, "waiting"> | "approval" | "capacity";

/** The workspace's own computer as every screen says it (onboarding, notice, Computers, the agent's page, phone). */
export interface SetupView {
  phase: SetupPhase;
  /** While preparing: the step, and its number from 1 (0 before the provisioner names one). */
  step: ComputerSetupStep | null;
  stepNumber: number;
  /** While waiting: `approval` (soon) or `capacity` (longer than usual). */
  reason: "approval" | "capacity" | null;
  /** The status line. */
  textKey: `computerSetup.step.${ComputerSetupStep}` | `computerSetup.status.${SetupStatus}`;
  /** The short word for a chip. */
  chipKey: `computerSetup.chip.${SetupStatus}`;
  /** `computerSetup.specs`'s values ("4 CPUs · 8 GB…"), once the provisioner said. */
  specs: ComputerSetup["specs"];
  /** The computer itself, once made (its page). */
  machineId: string | null;
}

/** Null where people connect their own computers (`pair`), or before the server answers: nothing to show. */
export function setupView(setup: ComputerSetup | null | undefined): SetupView | null {
  if (setup?.mode !== "external") return null;
  const phase: SetupPhase = setup.state ?? "preparing";
  const step = phase === "preparing" && setup.step && SETUP_STEPS.includes(setup.step) ? setup.step : null;
  const reason = phase === "waiting" ? (setup.reason === "capacity" ? "capacity" : "approval") : null;
  const status: SetupStatus = reason ?? (phase === "waiting" ? "approval" : phase);
  return {
    phase,
    step,
    stepNumber: step ? SETUP_STEPS.indexOf(step) + 1 : 0,
    reason,
    textKey: step ? `computerSetup.step.${step}` : `computerSetup.status.${status}`,
    chipKey: `computerSetup.chip.${status}`,
    specs: setup.specs,
    machineId: setup.machineId,
  };
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

/** "Oficina E2E's computer" until an admin gives it a name of its own (it starts with the workspace's). */
export const managedTitle = (t: TFunction, name: string | null | undefined, orgName: string) =>
  name && name !== orgName ? name : t("computerSetup.title", { org: orgName });

/** A computer as people call it: the workspace's own by `managedTitle` (a list row's `kind`, an outage's `managed`). */
export const computerName = (
  t: TFunction,
  c: { name: string | null; kind?: string; managed?: boolean },
  orgName: string,
) => (c.kind === "managed" || c.managed ? managedTitle(t, c.name, orgName) : (c.name ?? ""));
