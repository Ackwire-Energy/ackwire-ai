import type { AgentComputer } from "../api/types";

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
