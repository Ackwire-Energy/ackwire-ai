import { type MessagePin, usePinMessage, usePins } from "@agenteschat/client";
import { previewOf } from "@agenteschat/client/lib/consultations";
import { clockAt } from "@agenteschat/client/lib/format";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, CountChip, Popover } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./threads/threads.css";

/**
 * The channel header's "Fixadas": a popover with the pinned messages, the latest pin first (who wrote it, the start of
 * it, when). A row goes to the message (a thread's opens its thread); "Desafixar" for whoever may post. Live through
 * `message.pinned` / `message.unpinned`, which refresh the pins query.
 */
export function ChannelPinsButton({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const pin = usePinMessage(org.id);
  const [open, setOpen] = useState(false);
  const pins = usePins(org.id, channelId).data ?? [];
  const mayUnpin = can(org, "post");
  const go = (p: MessagePin) => {
    setOpen(false);
    if (p.threadId && actions?.openThread) actions.openThread(p.threadId);
    else actions?.jumpTo?.(p.messageId);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      className="thread-pop pins-pop"
      label={t("channel.pins.label", { channel: channelName })}
      trigger={
        <Button size="sm" icon="pin" aria-label={t("channel.pins.button", { count: pins.length })}>
          <span className="thread-pop__label">{t("channel.pins.title")}</span>
          {pins.length > 0 && <CountChip>{pins.length}</CountChip>}
        </Button>
      }
    >
      <div className="thread-pop__head">
        <b>{t("channel.pins.in", { channel: channelName })}</b>
        {pins.length > 0 && <small>{pins.length}</small>}
      </div>
      {pins.length === 0 && <p className="thread-pop__empty">{t("channel.pins.empty")}</p>}
      <div className="thread-pop__list">
        {pins.map((p) => {
          const author = p.message.author;
          const name = dir.authorName(author);
          return (
            <div key={p.messageId} className="pins-pop__item">
              <button type="button" className="thread-pop__row" onClick={() => go(p)}>
                {author.id ? (
                  <ActorAvatar actor={{ type: author.type, id: author.id }} name={name} size="sm" />
                ) : (
                  <span />
                )}
                <span className="thread-pop__text">
                  <b>{name}</b>
                  <small>{previewOf(textOrMedia(t, p.message.body, p.message.meta))}</small>
                </span>
                <small className="pins-pop__time">{clockAt(i18n.language, p.message.createdAt)}</small>
              </button>
              {mayUnpin && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="close"
                  aria-label={t("channel.pins.unpin", { name })}
                  title={t("contextMenu.unpin")}
                  disabled={pin.isPending}
                  onClick={() => pin.mutate({ channelId, messageId: p.messageId, pinned: false })}
                />
              )}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
