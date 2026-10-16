import { Button, Menu, MenuItem } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Message } from "@/api/types";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { threadStartOf } from "@/lib/threads";
import { useToast } from "@/lib/toast";
import { ReactButton, reactionOf, useMessageReactions } from "./Reactions";
import { SaveToWikiDialog } from "./SaveToWiki";

/** A message's address: the channel with `?m=` (the timeline scrolls to it). */
export const messageLink = (origin: string, orgId: string, m: Pick<Message, "id" | "channelId">) =>
  `${origin}/org/${orgId}/c/${m.channelId}?m=${m.id}`;

/** "…" on any message: Salvar na wiki, Copiar link, Responder, Responder em thread. */
export function MessageMoreMenu({ message, channelName }: { message: Message; channelName: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useChannelActions();
  const [saving, setSaving] = useState(false);
  return (
    <>
      <Menu
        align="end"
        label={t("channel.more")}
        trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={t("channel.more")} />}
      >
        <MenuItem icon="book" onSelect={() => setSaving(true)}>
          {t("wiki.save")}
        </MenuItem>
        <MenuItem
          icon="link"
          onSelect={async () => {
            await navigator.clipboard?.writeText(messageLink(window.location.origin, org.id, message));
            toast.show(t("channel.linkCopied"));
          }}
        >
          {t("channel.copyLink")}
        </MenuItem>
        {actions?.quoteReply && (
          <MenuItem icon="reply" onSelect={() => actions.quoteReply?.(message)}>
            {t("channel.quoteReply")}
          </MenuItem>
        )}
        {actions?.createThreadFrom && !message.threadId && !message.local && !threadStartOf(message.meta) && (
          <MenuItem icon="thread" onSelect={() => actions.createThreadFrom?.(message)}>
            {t("threads.createFromHere")}
          </MenuItem>
        )}
        {actions?.replyInThread && (
          <MenuItem icon="message" onSelect={() => actions.replyInThread?.(message)}>
            {t("channel.replyInThread")}
          </MenuItem>
        )}
      </Menu>
      <SaveToWikiDialog
        open={saving}
        onClose={() => setSaving(false)}
        text={message.body}
        source={{ kind: "message", channelId: message.channelId, messageId: message.id }}
        from={t("wiki.fromMessage", { channel: channelName })}
      />
    </>
  );
}

/** "Responder" on the hover bar: the next message quotes this one. */
export function QuoteReplyButton({ message }: { message: Message }) {
  const { t } = useTranslation();
  const actions = useChannelActions();
  if (!actions?.quoteReply) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon="reply"
      aria-label={t("channel.quoteReply")}
      onClick={() => actions.quoteReply?.(message)}
    />
  );
}

/** People's messages: the same glass bar as agents': Reagir, Responder and "…". */
export function PersonMessageActions({
  message,
  authorName,
  channelName,
}: {
  message: Message;
  authorName: string;
  channelName: string;
}) {
  const { t } = useTranslation();
  const reactions = useMessageReactions(message.id, message.reactions);
  return (
    <div className="ac-msg__actions" role="toolbar" aria-label={t("channel.actions", { name: authorName })}>
      <ReactButton onPick={(emoji) => reactions.toggle(reactionOf(emoji))} />
      <QuoteReplyButton message={message} />
      <MessageMoreMenu message={message} channelName={channelName} />
    </div>
  );
}
