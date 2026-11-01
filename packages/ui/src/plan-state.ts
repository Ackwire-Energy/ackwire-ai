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
  /** The compact line's name: "5h", "semana", or the window's `label`. */
  short(w: PlanMeterWindow): string;
  /** "renova às 15:40", "renova sex às 10:00". */
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
/** From here a window's bar is red: one long task can take a 5-hour window's last tenth. */
export const PLAN_CRITICAL = 90;

export type PlanLevel = "ok" | "almost" | "critical" | "limited";

/** How close a window (or the plan: `limited` when it refused a request) is to its limit, as its bar is colored. */
export const planLevel = (used: number, limited = false): PlanLevel =>
  limited || used >= 100 ? "limited" : used >= PLAN_CRITICAL ? "critical" : used >= PLAN_ALMOST ? "almost" : "ok";

/** Each level's color token: the phone's `c[...]`. The web maps the same levels in components.css. */
export const PLAN_TONE = {
  ok: "ink",
  almost: "warn",
  critical: "danger",
  limited: "danger",
} as const satisfies Record<PlanLevel, "ink" | "warn" | "danger">;

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

/** How many windows the compact line names; every window is in its title and in the full meter. */
const LINE_WINDOWS = 2;

/**
 * The compact meter's words: the tightest windows by their short names ("semana 40% · 5h 12%"), every window
 * with its reset for the title, the tightest (`top`) for its one bar, and only near or at the limit what matters then
 * ("Quase no limite · renova às 14:00", "No limite até 14:00"). Null while no window is known: nothing, never 0%.
 * A plan that refused a request before any window was known is still at the limit: no windows, no bar, only the alert.
 */
export function planLine(usage: PlanMeterUsage, text: PlanMeterText, now = Date.now()) {
  const rows = planWindows(usage, now);
  const top = rows[0];
  const { state, until } = planState(usage, now);
  if (!top && state !== "limited") return null;
  const reset = (w?: PlanMeterWindow) => (w?.resetsAt && !passed(w.resetsAt, now) ? text.resets(w.resetsAt) : null);
  const join = (parts: (string | null)[]) => parts.filter(Boolean).join(" · ");
  return {
    state,
    top,
    line: rows
      .slice(0, LINE_WINDOWS)
      .map((w) => `${text.short(w)} ${w.used}%`)
      .join(" · "),
    title: rows.map((w) => join([`${text.window(w)} ${w.used}%`, reset(w)])).join("\n"),
    alert: state === "limited" ? text.limited(until) : state === "almost" ? join([text.almost, reset(top)]) : null,
  };
}

/** What `limitOffers` reads of an AI account (the API's `MachineAccount`). */
export interface OfferAccount {
  id: string;
  kind: string;
  /** A coding plan's maker; null: the CLI's own sign-in. */
  provider: string | null;
  mine: boolean;
  status: string;
  usedBy: readonly string[];
  usage: PlanMeterUsage | null;
  /** It thinks for every agent its owner gives it on that computer. */
  shared?: boolean;
}

/**
 * At the limit, the owner's other accounts that could think instead: of the
 * same kind and plan maker (another maker's models would think instead),
 * signed in, not at their own limit, and free or made for all of the owner's
 * agents there. A login another agent thinks with is never offered (it serves
 * one agent; moving plans between agents to dodge a limit isn't). Most
 * headroom first, unknown usage last. Shared by the web's and the phone's
 * agent settings.
 */
export function limitOffers<A extends OfferAccount>(
  accounts: readonly A[],
  kind: string,
  current: string | null,
  now = Date.now(),
): { account: A; used: number | null }[] {
  const provider = accounts.find((a) => a.id === current)?.provider ?? null;
  return accounts
    .filter(
      (a) =>
        a.mine &&
        a.kind === kind &&
        (a.provider ?? null) === provider &&
        a.id !== current &&
        a.status === "active" &&
        (a.usedBy.length === 0 || a.shared === true),
    )
    .map((account) => ({ account, plan: account.usage ? planState(account.usage, now) : null }))
    .filter((o) => o.plan?.state !== "limited")
    .map((o) => ({ account: o.account, used: o.plan?.used ?? null }))
    .sort((a, b) => (a.used ?? 101) - (b.used ?? 101));
}
