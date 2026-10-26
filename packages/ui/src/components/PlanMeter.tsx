import { cx } from "../cx";
import { PLAN_ALMOST, type PlanMeterText, type PlanMeterUsage, planState, planWindows } from "../plan-state";
import { Meter } from "./Surfaces";

export {
  PLAN_ALMOST,
  type PlanMeterText,
  type PlanMeterUsage,
  type PlanMeterWindow,
  type PlanState,
  planState,
  planWindows,
} from "../plan-state";

const passed = (iso: string | undefined, now: number) => iso !== undefined && Date.parse(iso) <= now;

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
            // A window that reset is empty again: its parts were the old window's.
            const fresh = !passed(w.resetsAt, now);
            return (
              <li key={`${w.kind}:${w.label ?? i}`} className="ac-planmeter__window">
                <span className="ac-planmeter__name">{name}</span>
                <span className="ac-planmeter__pct">{w.used}%</span>
                <Meter
                  value={w.used}
                  max={100}
                  label={name}
                  marks={[PLAN_ALMOST]}
                  {...(w.part !== undefined && fresh ? { part: w.part } : {})}
                />
                {!compact && w.note && fresh && <small className="ac-planmeter__note">{w.note}</small>}
                {!compact && w.resetsAt && fresh && (
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
