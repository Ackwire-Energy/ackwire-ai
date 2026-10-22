import type { Message } from "@agenteschat/client";
import { Button, Menu, MenuItem } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { contextMenuHandler, copyText, type MenuEntry, QUICK_REACTIONS } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { ReactButton, reactionOf, useMessageReactions } from "./Reactions";
import { SaveToWikiDialog } from "./SaveToWiki";

/** A message's address: the channel with `?m=` (the timeline scrolls to it). */
export const messageLink = (origin: string, orgId: string, m: Pick<Message, "id" | "channelId">) =>
  `${origin}/org/${orgId}/c/${m.channelId}?m=${m.id}`;

/** "…" on any message: Salvar na wiki, Copiar link, Responder. */
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
        {actions?.reply && !message.local && (
          <MenuItem icon="reply" onSelect={() => actions.reply?.(message)}>
            {t("channel.reply")}
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

/** "Responder" on the hover bar: the message's thread in the panel (a thread view: the composer). */
export function ReplyButton({ message }: { message: Message }) {
  const { t } = useTranslation();
  const actions = useChannelActions();
  if (!actions?.reply || message.local) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon="reply"
      aria-label={t("channel.reply")}
      title={t("channel.reply")}
      onClick={() => actions.reply?.(message)}
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
      <ReplyButton message={message} />
      <MessageMoreMenu message={message} channelName={channelName} />
    </div>
  );
}

/**
 * A message's right click in the desktop app (lib/context-menu.ts): quick reactions, then what its "…" has
 * (Responder, Copiar link, Salvar na wiki) and Copiar texto. `dialog` goes with the message (Salvar na wiki).
 */
export function useMessageMenu(message: Message, channelName: string, options: { feedback?: boolean } = {}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useChannelActions();
  const reactions = useMessageReactions(message.id, message.reactions, { feedback: options.feedback });
  const [saving, setSaving] = useState(false);
  const onContextMenu = contextMenuHandler((): MenuEntry[] =>
    message.local
      ? []
      : [
          {
            kind: "reactions",
            label: t("contextMenu.react"),
            emojis: QUICK_REACTIONS,
            pick: (emoji) => reactions.toggle(reactionOf(emoji)),
          },
          ...(actions?.reply
            ? ([
                {
                  kind: "item",
                  id: "reply",
                  label: t("contextMenu.reply"),
                  icon: "reply",
                  run: () => actions.reply?.(message),
                },
              ] satisfies MenuEntry[])
            : []),
          {
            kind: "item",
            id: "copy-text",
            label: t("contextMenu.copyText"),
            icon: "copy",
            run: () => void copyText(message.body, () => toast.show(t("contextMenu.textCopied"))),
          },
          {
            kind: "item",
            id: "copy-link",
            label: t("contextMenu.copyLink"),
            icon: "link",
            run: () =>
              void copyText(messageLink(window.location.origin, org.id, message), () =>
                toast.show(t("contextMenu.linkCopied")),
              ),
          },
          { kind: "separator" },
          { kind: "item", id: "wiki", label: t("contextMenu.saveToWiki"), icon: "book", run: () => setSaving(true) },
        ],
  );
  const dialog = saving ? (
    <SaveToWikiDialog
      open
      onClose={() => setSaving(false)}
      text={message.body}
      source={{ kind: "message", channelId: message.channelId, messageId: message.id }}
      from={t("wiki.fromMessage", { channel: channelName })}
    />
  ) : null;
  return { onContextMenu, dialog };
}
