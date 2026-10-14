import { Avatar } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import type { Message } from "@/api/types";
import { useDirectory } from "@/hooks/useDirectory";
import { joinNames } from "@/lib/format";
import { useLive } from "@/realtime/context";
import { receiptView } from "@/realtime/receipts";
import { CallAgentMenu, useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";

/**
 * Under a person's message: tiny agent avatars of who saw it, then who will
 * answer / is answering / answered. Muted text; the only color is the
 * agent avatar. Updates live.
 */
export function MessageReceipts({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const receipt = useLive((s) => s.receipts[message.id]);
  const view = receiptView(receipt);
  if (view.seen.length === 0) return null;

  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const names = (ids: string[]) => joinNames(ids.map(name), t("newAgent.and"));
  const status = view.status;
  const text =
    status === null
      ? ""
      : status.kind === "nobody"
        ? t("receipts.nobody")
        : t(`receipts.${status.kind}`, { count: status.agents.length, names: names(status.agents) });
  const label = [t("receipts.seenBy", { names: names(view.seen) }), text].filter(Boolean).join("; ");

  return (
    <div className="ac-receipt" role="status" aria-label={label} data-done={view.done}>
      <span className="ac-receipt__avatars" aria-hidden="true">
        {view.seen.map((id) => (
          <Avatar key={id} kind="agent" size="xs" name={name(id)} initials={dir.agentInitials(id)} />
        ))}
      </span>
      {text && (
        <span className="ac-receipt__text" aria-hidden="true">
          {text}
        </span>
      )}
      {status?.kind === "failed" && actions && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="ac-receipt__action" onClick={() => actions.resend(message.body)}>
            {t("receipts.retry")}
          </button>
        </>
      )}
      {status?.kind === "nobody" && (
        <>
          <span aria-hidden="true">·</span>
          <CallAgentMenu />
        </>
      )}
    </div>
  );
}
