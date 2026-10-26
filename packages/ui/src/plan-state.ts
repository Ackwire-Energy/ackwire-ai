/**
 * Where a plan's usage stands, without React (the web's `PlanMeter` and the phone's meter share it).
 */

/** A plan's usage window, as the API's `PlanUsage` says it. */
export interface PlanMeterWindow {
  kind: string;
  /** `other`: the provider's name for it. */
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  /** An estimated part of `usedPercent` (one agent's), in full ink over the rest of the bar. */
  part?: number;
  /** Words under the bar: whose use it is. */
  note?: string;
}

export interface PlanMeterUsage {
  windows: readonly PlanMeterWindow[];
  /** The plan refused a request for its limit. */
  limited?: boolean;
  at: string;
}

/** What the meter says, in the viewer's language. */
export interface PlanMeterText {
  /** "5 horas", "Semana", or the window's `label`. */
  window(w: PlanMeterWindow): string;
  /** "volta às 15:40", "volta sex às 10:00". */
  resets(iso: string): string;
  /** "Quase no limite". */
  almost: string;
  /** "No limite até 15:40"; `until` null: when it resets isn't known. */
  limited(until: string | null): string;
  /** "Atualizado há 3 min". */
  updated(iso: string): string;
}

export type PlanState = "ok" | "almost" | "limited";

/** The usage at which a plan is "almost at the limit". */
export const PLAN_ALMOST = 80;

const KIND_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "monthly", "other"];
const passed = (iso: string | undefined, now: number) => iso !== undefined && Date.parse(iso) <= now;

/**
 * The windows tightest first (the most used, then the shortest), each with
 * `used` as it stands now: a window whose reset already passed is empty again.
 */
export function planWindows<W extends PlanMeterWindow>(usage: { windows: readonly W[] }, now = Date.now()) {
  return usage.windows
    .map((w) => ({ ...w, used: passed(w.resetsAt, now) ? 0 : w.usedPercent }))
    .sort((a, b) => b.used - a.used || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/**
 * Where the plan stands: at its limit (a window is full, or it refused a
 * request and no full window has reset since), almost (`PLAN_ALMOST`), or fine.
 * `until`: when every full window has reset; `used`: the tightest window's.
 */
export function planState(
  usage: PlanMeterUsage,
  now = Date.now(),
): { state: PlanState; until: string | null; used: number } {
  const rows = planWindows(usage, now);
  const full = rows.filter((w) => w.used >= 100);
  const refused = usage.limited === true && !usage.windows.some((w) => w.usedPercent >= 100);
  const used = rows[0]?.used ?? 0;
  if (full.length === 0 && !refused) return { state: used >= PLAN_ALMOST ? "almost" : "ok", until: null, used };
  const resets = full.flatMap((w) => (w.resetsAt ? [w.resetsAt] : []));
  const until = full.length > 0 && resets.length === full.length ? (resets.sort().at(-1) ?? null) : null;
  return { state: "limited", until, used };
}
