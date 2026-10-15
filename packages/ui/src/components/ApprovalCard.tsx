import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Chip } from "./Chip";

export type ApprovalStatus = "waiting" | "approved" | "refused";

export interface ApprovalCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  status: ApprovalStatus;
  /** Who asks, e.g. <><b>Ada</b> pede aprovação</>. */
  who: ReactNode;
  /** Chip text: "Aguardando você", "Expira em 23 h", "Aprovado por você · agora". */
  statusLabel?: ReactNode;
  /** The action in human words: "Fazer merge do PR #42 em main". Omitted on the compact decided card. */
  title?: ReactNode;
  /** Exact detail (tool, target, expiry). */
  detail?: ReactNode;
  /** Buttons: "Aprovar …" (primary), "Recusar", "Ver diff" (ghost). */
  actions?: ReactNode;
  /** Small agent avatar before `who` (list pages). */
  avatar?: ReactNode;
  /** Decided cards shrink to one line. */
  compact?: boolean;
  wide?: boolean;
  /** Decorative backdrop at the top of the card (the agent's pixel sky while it waits). */
  sky?: ReactNode;
  as?: "div" | "article";
}

/**
 * A human approval for a sensitive action, inside the chat. Neutral card with
 * the agent's cut corner; the only color is the status chip.
 */
export function ApprovalCard({
  status,
  who,
  statusLabel,
  title,
  detail,
  actions,
  avatar,
  compact,
  wide,
  sky,
  as: Tag = "div",
  className,
  ...rest
}: ApprovalCardProps) {
  const icon = status === "waiting" ? "waiting" : status === "approved" ? "check" : "close";
  const tone = status === "waiting" ? "waiting" : status === "approved" ? "done" : "neutral";
  return (
    <Tag
      className={cx("ac-approval", compact && "ac-approval--done", wide && "ac-approval--wide", className)}
      role={Tag === "div" ? "group" : undefined}
      {...rest}
    >
      {sky}
      <div className="ac-approval__head">
        {avatar}
        <span className="ac-approval__who">{who}</span>
        {statusLabel && (
          <Chip icon={icon} tone={tone}>
            {statusLabel}
          </Chip>
        )}
      </div>
      {title && <p className="ac-approval__title">{title}</p>}
      {detail && <p className="ac-approval__detail">{detail}</p>}
      {actions && <div className="ac-approval__actions">{actions}</div>}
    </Tag>
  );
}
