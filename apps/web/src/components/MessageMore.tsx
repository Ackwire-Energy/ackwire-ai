import type { Message } from "@agenteschat/client";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { Button, EmojiPickerPopover, Menu, MenuItem } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { contextMenuHandler, copyText, type MenuEntry, QUICK_REACTIONS, selectedTextAt } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { CorrectionDialog } from "./MessageFeedback";
import { DOWN, ReactButton, reactionOf, useEmojiLabels, useMessageReactions } from "./Reactions";
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
  // Only a GIF, a sticker or files (ADR 0091): no words to save, as in the right-click menu.
  const words = message.body.trim() !== "" && !voiceOf(message.meta);
  return (
    <>
      <Menu
        align="end"
        label={t("channel.more")}
        trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={t("channel.more")} />}
      >
        {words && (
          <MenuItem icon="book" onSelect={() => setSaving(true)}>
            {t("wiki.save")}
          </MenuItem>
        )}
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
 * (Responder, Copiar link, Salvar na wiki) and Copiar texto. With text selected in it, the selection's own menu
 * (Copiar, Responder; Salvar na wiki saves the selection). `touch` is the same menu for a tap on touch, where it stands
 * in for the bar, so it also has the bar's every emoji, and an agent's reply (`feedback`) the bar's Não ajudou and
 * Corrigir resposta. `dialog` goes with the message.
 */
export function useMessageMenu(
  message: Message,
  channelName: string,
  options: { feedback?: boolean; agentName?: string } = {},
) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useChannelActions();
  const reactions = useMessageReactions(message.id, message.reactions, { feedback: options.feedback });
  // What Salvar na wiki saves: the selection when it was asked, else the whole message.
  const [saving, setSaving] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const labels = useEmojiLabels();
  const entries = (selected: string, touch = false): MenuEntry[] => {
    if (message.local) return [];
    const copy = (text: string, id: string, label: string): MenuEntry => ({
      kind: "item",
      id,
      label,
      icon: "copy",
      run: () => void copyText(text, () => toast.show(t("contextMenu.textCopied"))),
    });
    const reply: MenuEntry[] = actions?.reply
      ? [
          {
            kind: "item",
            id: "reply",
            label: t("contextMenu.reply"),
            icon: "reply",
            run: () => actions.reply?.(message),
          },
        ]
      : [];
    const copyLink: MenuEntry = {
      kind: "item",
      id: "copy-link",
      label: t("contextMenu.copyLink"),
      icon: "link",
      run: () =>
        void copyText(messageLink(window.location.origin, org.id, message), () =>
          toast.show(t("contextMenu.linkCopied")),
        ),
    };
    const wiki = (text: string): MenuEntry => ({
      kind: "item",
      id: "wiki",
      label: t("contextMenu.saveToWiki"),
      icon: "book",
      run: () => setSaving(text),
    });
    if (selected) {
      return [copy(selected, "copy", t("contextMenu.copy")), ...reply, { kind: "separator" }, copyLink, wiki(selected)];
    }
    // A file with no words has no text to copy or save.
    const words = message.body.trim() !== "" && !voiceOf(message.meta);
    return [
      {
        kind: "reactions",
        label: t("contextMenu.react"),
        emojis: QUICK_REACTIONS,
        pick: (emoji) => reactions.toggle(reactionOf(emoji)),
        ...(touch ? { more: { label: t("reactions.add"), run: () => setPicking(true) } } : {}),
      },
      ...reply,
      ...(touch && options.feedback
        ? ([
            {
              kind: "item",
              id: "not-helpful",
              label: t("channel.notHelpful"),
              icon: "thumbDown",
              run: () => reactions.toggle(DOWN),
            },
            { kind: "item", id: "correct", label: t("channel.correct"), icon: "edit", run: () => setCorrecting(true) },
          ] satisfies MenuEntry[])
        : []),
      ...(words ? [copy(message.body, "copy-text", t("contextMenu.copyText"))] : []),
      copyLink,
      ...(words ? ([{ kind: "separator" }, wiki(message.body)] satisfies MenuEntry[]) : []),
    ];
  };
  const onContextMenu = contextMenuHandler((e) => entries(selectedTextAt(e.target)));
  const touch = entries("", true);
  const dialog = (
    <>
      {saving !== null && (
        <SaveToWikiDialog
          open
          onClose={() => setSaving(null)}
          text={saving}
          source={{ kind: "message", channelId: message.channelId, messageId: message.id }}
          from={t("wiki.fromMessage", { channel: channelName })}
        />
      )}
      {correcting && (
        <CorrectionDialog
          open
          onOpenChange={setCorrecting}
          messageId={message.id}
          agentName={options.agentName ?? ""}
        />
      )}
      {picking && (
        <EmojiPickerPopover
          open
          onOpenChange={setPicking}
          labels={labels}
          onPick={(emoji) => reactions.toggle(reactionOf(emoji))}
          side="bottom"
          align="end"
          // The whole row's box (`.ac-msg` is positioned): the picker opens beside the row, as its menu did.
          trigger={<span aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />}
        />
      )}
    </>
  );
  return { onContextMenu, touch, dialog };
}
