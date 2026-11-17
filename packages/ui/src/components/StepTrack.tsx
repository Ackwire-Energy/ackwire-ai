import { type CSSProperties, type HTMLAttributes, type ReactNode, useState } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type StepTrackState = "done" | "now" | "after" | "failed";

export interface StepTrackStep {
  key: string;
  /** An icon name, or a node in its place (an app's logo). */
  icon: IconName | ReactNode;
  /** What the step did: "Read the PR", "Ran the tests". */
  label: string;
  /** The whole line, when it says more than the label. */
  title?: string;
  time?: string;
  /** `done` before it, `now` the step that waits on a person, `after` what followed a decision, `failed`. */
  state?: StepTrackState;
}

const MORE = "\u0000more";

/**
 * A run's steps as one horizontal track of nodes joined by a line, and under it one line that tells a single step
 * whole: the one that waits on a person (else the last), or the one under the pointer, the focus or the last press.
 * A node has no room for words under it, so the words live on that line and are never cut. Past `max` steps, the
 * middle ones fold into one "+N" node so the track keeps one row: a press on it calls `onMore` (show them all).
 */
export function StepTrack({
  steps,
  max = 8,
  more,
  onMore,
  className,
  ...rest
}: {
  steps: StepTrackStep[];
  max?: number;
  /** The folded node's words ("16 steps"). */
  more?: (count: number) => string;
  /** A press on the folded node: show the steps it holds. Without it the press tells how many, like any node. */
  onMore?: () => void;
} & HTMLAttributes<HTMLOListElement>) {
  const [picked, setPicked] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const folded = steps.length > max;
  const head = folded ? steps.slice(0, 2) : steps;
  const tail = folded ? steps.slice(steps.length - (max - 3)) : [];
  const hidden = steps.length - head.length - tail.length;
  const fold: StepTrackStep = { key: MORE, icon: null, label: more ? more(hidden) : `+${hidden}` };
  const shown = folded ? [...head, fold, ...tail] : head;
  const told =
    shown.find((s) => s.key === peek) ??
    shown.find((s) => s.key === picked) ??
    shown.find((s) => s.state === "now") ??
    shown.at(-1);
  return (
    <div className={cx("ac-track", className)}>
      <ol className="ac-track__steps" style={{ "--n": shown.length } as CSSProperties} {...rest}>
        {shown.map((s) => (
          <li key={s.key} className={cx("ac-track__step", s.key === MORE ? "is-more" : s.state && `is-${s.state}`)}>
            <button
              type="button"
              className="ac-track__node"
              aria-label={[s.title ?? s.label, s.time].filter(Boolean).join(" · ")}
              // The waiting step is the current one, whichever the line tells: a focused node always tells itself.
              aria-current={s.state === "now" ? "step" : undefined}
              data-told={s === told ? "" : undefined}
              onMouseEnter={() => setPeek(s.key)}
              onMouseLeave={() => setPeek(null)}
              onFocus={() => setPeek(s.key)}
              onBlur={() => setPeek(null)}
              onClick={() => (s.key === MORE && onMore ? onMore() : setPicked(s.key))}
            >
              {s.key === MORE ? (
                `+${hidden}`
              ) : typeof s.icon === "string" ? (
                <Icon name={s.icon as IconName} size={14} />
              ) : (
                s.icon
              )}
            </button>
          </li>
        ))}
      </ol>
      {told && (
        <p className={cx("ac-track__line", told.state && `is-${told.state}`)}>
          <span className="ac-track__label">{told.title ?? told.label}</span>
          {told.time && <span className="ac-track__time"> · {told.time}</span>}
        </p>
      )}
    </div>
  );
}
