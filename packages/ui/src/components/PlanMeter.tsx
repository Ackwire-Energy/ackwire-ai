import { cx } from "../cx";
import { Meter } from "./Surfaces";

/** A plan's usage window, as the API's `PlanUsage` says it. */
export interface PlanMeterWindow {
  kind: string;
  /** `other`: the provider's name for it. */
  label?: string;
  usedPercent: number;
  resetsAt?: string;
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

/**
 * A plan's usage like the provider shows it: a bar per window, tightest first,
 * with its percentage and when it resets; "almost" from 80%, "at the limit
 * until…" at 100%, and how old the numbers are. `compact`: the tightest window
 * only. The bars are ink; the state is said in words.
 */
export function PlanMeter({
  usage,
  text,
  compact = false,
  now = Date.now(),
  className,
}: {
  usage: PlanMeterUsage;
  text: PlanMeterText;
  compact?: boolean;
  now?: number;
  className?: string;
}) {
  const rows = planWindows(usage, now);
  const { state, until } = planState(usage, now);
  const headline = state === "limited" ? text.limited(until) : state === "almost" ? text.almost : null;
  return (
    <div className={cx("ac-planmeter", compact && "ac-planmeter--compact", className)} data-state={state}>
      {headline && <p className="ac-planmeter__state">{headline}</p>}
      {rows.length > 0 && (
        <ul className="ac-planmeter__windows">
          {(compact ? rows.slice(0, 1) : rows).map((w, i) => {
            const name = text.window(w);
            return (
              <li key={`${w.kind}:${w.label ?? i}`} className="ac-planmeter__window">
                <span className="ac-planmeter__name">{name}</span>
                <span className="ac-planmeter__pct">{w.used}%</span>
                <Meter value={w.used} max={100} label={name} marks={[PLAN_ALMOST]} />
                {!compact && w.resetsAt && !passed(w.resetsAt, now) && (
                  <small className="ac-planmeter__reset">{text.resets(w.resetsAt)}</small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!compact && <small className="ac-planmeter__at">{text.updated(usage.at)}</small>}
    </div>
  );
}
