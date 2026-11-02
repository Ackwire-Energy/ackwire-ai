import { type MessagePin, usePinMessage, usePins } from "@agenteschat/client";
import { previewOf } from "@agenteschat/client/lib/consultations";
import { clockAt } from "@agenteschat/client/lib/format";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { pinsIn } from "@agenteschat/client/lib/pins";
import { Button, CountChip, Icon, Popover } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./threads/threads.css";

/**
 * The pinned bar under a conversation's header (channel, DM or thread), only while something is pinned there: the
 * latest pin (who wrote it, its first line) and how many there are. A click opens every pin, the latest first; a row
 * goes to the message (paged in and highlighted; a thread's opens its thread at it), "Desafixar" for whoever may post.
 * Live through `message.pinned` / `message.unpinned`, which refresh the pins query.
 */
export function ChannelPinnedBar({
  channelId,
  channelName,
  threadId,
}: {
  channelId: string;
  /** A channel's name (`#name` in the list's title); none in a DM or a thread. */
  channelName?: string;
  threadId?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const pin = usePinMessage(org.id);
  const [open, setOpen] = useState(false);
  const pins = pinsIn(usePins(org.id, channelId).data ?? [], threadId);
  const latest = pins[0];
  if (!latest) return null;
  const mayUnpin = can(org, "post");
  const go = (p: MessagePin) => {
    setOpen(false);
    if (!threadId && p.threadId && actions?.openThread) actions.openThread(p.threadId, p.messageId);
    else actions?.jumpTo?.(p.messageId);
  };
  const preview = (p: MessagePin) => previewOf(textOrMedia(t, p.message.body, p.message.meta));
  const title = channelName ? t("channel.pins.in", { channel: channelName }) : t("channel.pins.title");
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      className="thread-pop pins-pop"
      label={channelName ? t("channel.pins.label", { channel: channelName }) : t("channel.pins.title")}
      trigger={
        <button type="button" className="pinbar" aria-label={t("channel.pins.button", { count: pins.length })}>
          <Icon name="pin" size={14} />
          <span className="pinbar__text">
            <b>{dir.authorName(latest.message.author)}</b> {preview(latest)}
          </span>
          {pins.length > 1 && <CountChip>{pins.length}</CountChip>}
        </button>
      }
    >
      <div className="thread-pop__head">
        <b>{title}</b>
        <small>{pins.length}</small>
      </div>
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
                  <small>{preview(p)}</small>
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
