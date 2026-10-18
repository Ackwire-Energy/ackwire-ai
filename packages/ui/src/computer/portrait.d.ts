/** Types for portrait.js (plain JavaScript so the HTML prototypes can import it as is). */

export type ComputerKind = "mac" | "windows" | "linux" | "cloud";
export type ComputerState = "online" | "paused" | "offline";

/** The 2D context subset the portraits draw with. */
export type ComputerCtx = Pick<CanvasRenderingContext2D, "fillRect" | "clearRect"> & { fillStyle: unknown };

export const COMPUTER_GRID: 48;
export const COMPUTER_KINDS: ComputerKind[];
export const COMPUTER_STATES: ComputerState[];

export function drawComputer(
  ctx: ComputerCtx,
  kind: ComputerKind,
  state: ComputerState,
  options?: { dark?: boolean; t?: number },
): void;
