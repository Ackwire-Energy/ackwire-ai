import type { Widget, WidgetFailure } from "@agenteschat/client";
import { widgetFailureKey } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { type AgentColor, Icon, PixelSpinner } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";

/** The widget's agent as a board shows it: its name and its color (sky when it is gone). */
export function useWidgetAgent(agentId: string) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.anyAgent(agentId);
  return { agent, name: agent?.name ?? t("channel.unknownAgent"), color: colorOf(agent) };
}

/** Why a widget stopped updating, in the reader's words (the agent's own when it said why). */
export function failureText(t: TFunction, failure: WidgetFailure | null, name: string): string {
  if (!failure) return t("widgets.failure.error");
  if (failure.code === "agent_reported" && failure.detail) return failure.detail;
  const key = widgetFailureKey(failure.code === "agent_reported" ? "error" : failure.code);
  return t(key, { name, detail: failure.detail ?? "" });
}

/**
 * A widget's footer on a board (ADR 0134): who looks after it, when it last updated and how often; while it is built
 * or updated, the agent at it; failed, why, with Resolve (an update asked now).
 */
export function WidgetFoot({
  widget,
  name,
  color,
  now,
  onResolve,
  resolving = false,
}: {
  widget: Widget;
  name: string;
  color: AgentColor;
  now: number;
  /** Resolve: run it again (only for whoever may). */
  onResolve?: () => void;
  resolving?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const schedule = t(`widgets.schedulesInline.${widget.schedule}`);
  if (widget.status === "building")
    return (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when">
          {name} <span className="wg__dot">·</span> {schedule}
        </span>
      </>
    );
  if (widget.status === "updating" || resolving)
    return (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when">{t("widgets.status.updating", { name })}</span>
      </>
    );
  if (widget.status === "failed")
    return (
      <span className="wg__warn" role="status">
        <Icon name="alert" size={14} />
        <span>
          {failureText(t, widget.failure, name)}{" "}
          {onResolve && (
            <button
              type="button"
              className="wg__resolve"
              onClick={(e) => {
                e.stopPropagation();
                onResolve();
              }}
            >
              {t("widgets.failure.resolve")}
            </button>
          )}
        </span>
      </span>
    );
  return (
    <>
      <AgentAvatar agentId={widget.agentId} name={name} size="xs" />
      <span className="wg__when">
        <b>{name}</b>
        {widget.refreshedAt && (
          <>
            {" "}
            <span className="wg__dot">·</span> {relativeTime(t, i18n.language, widget.refreshedAt, new Date(now))}
          </>
        )}{" "}
        <span className="wg__dot">·</span> {schedule}
      </span>
    </>
  );
}
