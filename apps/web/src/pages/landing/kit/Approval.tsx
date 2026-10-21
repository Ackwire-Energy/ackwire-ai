import { type AgentColor, ApprovalCard, Button, type ButtonProps, cx, ExpiryFuse, Icon } from "@agenteschat/ui";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

/**
 * Hold to approve, like the app's high-risk approvals (ApprovalsPage): the
 * button fills while held and fires after `ms`; letting go early does
 * nothing. `auto` plays the hold by itself after that many ms (the hero
 * approves on its own when nobody does).
 */
export function HoldButton({
  onDone,
  ms = 1100,
  auto,
  label,
  holdingLabel,
  size = "sm",
  block,
  className,
}: {
  onDone: () => void;
  ms?: number;
  auto?: number;
  label?: ReactNode;
  holdingLabel?: ReactNode;
  size?: ButtonProps["size"];
  block?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const start = () => {
    if (timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      done.current();
    }, ms);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: arm once per mount
  useEffect(() => {
    if (auto === undefined) return;
    const id = setTimeout(start, auto);
    return () => clearTimeout(id);
  }, [auto]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      variant="primary"
      size={size}
      block={block}
      icon="check"
      className={cx("lp-hold", holding && "is-holding", className)}
      style={{ "--hold-ms": `${ms}ms` } as CSSProperties}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button > 0) return;
        start();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
    >
      {holding ? (holdingLabel ?? t("approvals.holding")) : (label ?? t("approvals.hold"))}
    </Button>
  );
}

export type Decision = "yes" | "no";

/**
 * A sample approval request in the chat: the app's ApprovalCard with the
 * exact action (label/value rows), the fuse that burns to the deadline, hold
 * to approve and decline. Decided, it shrinks to one line.
 */
export function LpApproval({
  who,
  title,
  detail,
  rows,
  color = "sky",
  fuse = 0.86,
  decided,
  decidedLabel,
  waitingLabel,
  onDecide,
  hint,
  auto,
  noDecline,
  className,
}: {
  who: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** The exact action: [label, value] pairs. */
  rows?: [string, ReactNode][];
  color?: AgentColor;
  /** How much of the time is left (0–1). */
  fuse?: number;
  decided?: Decision;
  decidedLabel?: ReactNode;
  waitingLabel?: ReactNode;
  onDecide?: (choice: Decision) => void;
  hint?: ReactNode;
  /** Approves by itself after this many ms (see HoldButton). */
  auto?: number;
  /** Only the hold (the hero's small card has no room for "Recusar"). */
  noDecline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (decided)
    return (
      <ApprovalCard
        className={cx("lp-approval", className)}
        compact
        status={decided === "yes" ? "approved" : "refused"}
        who={who}
        statusLabel={decidedLabel}
        title={title}
      />
    );
  return (
    <ApprovalCard
      className={cx("lp-approval", className)}
      status="waiting"
      who={who}
      statusLabel={waitingLabel ?? t("landing.approval.waiting")}
      title={title}
      detail={
        detail || rows ? (
          <>
            {detail}
            {rows && (
              <span className="lp-exact">
                {rows.map(([k, v]) => (
                  <span key={k} className="lp-exact__row">
                    <span className="lp-exact__k">{k}</span>
                    <span className="lp-exact__v">{v}</span>
                  </span>
                ))}
              </span>
            )}
          </>
        ) : undefined
      }
      sky={<ExpiryFuse left={fuse} color={color} className="lp-approval__fuse" />}
      actions={
        onDecide && (
          <>
            <HoldButton onDone={() => onDecide("yes")} auto={auto} />
            {!noDecline && (
              <Button variant="ghost" size="sm" onClick={() => onDecide("no")}>
                {t("landing.approval.refuse")}
              </Button>
            )}
            {hint !== null && (
              <span className="lp-hint">
                <Icon name="approve" size={14} />
                {hint ?? t("landing.approval.holdHint")}
              </span>
            )}
          </>
        )
      }
    />
  );
}
