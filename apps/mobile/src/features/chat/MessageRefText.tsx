import { useMessageCard } from "@agenteschat/client";
import { type MessageLink, messageRefLabel } from "@agenteschat/client/lib/message-links";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { Icon } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors } from "../shared/hooks";
import { messageRefWords } from "./logic";

/**
 * A message's link in a message (the web's `MessageRef`): "#general › 💬", "@Ana › 💬" in a DM, "#general › Thread ›
 * 💬" for a reply; a tap opens the conversation at that message. One the viewer can't see is a plain "Mensagem sem
 * acesso" that names nothing of its place.
 */
export function MessageRefText({ link }: { link: MessageLink }) {
  const { t } = useTranslation();
  const c = useColors();
  const card = useMessageCard(link.orgId, link.messageId);
  const icon = <Icon name="chat" size={14} color={c.ink} />;
  if (card.isPending) {
    return (
      <RNText accessibilityLabel={t("messageRefs.message")} style={[styles.ref, { backgroundColor: c.sunken }]}>
        {icon}
      </RNText>
    );
  }
  const m = card.data;
  if (!m) {
    return (
      <RNText style={[styles.ref, { backgroundColor: c.sunken, color: c.muted }]}>{messageRefLabel(t, null)}</RNText>
    );
  }
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={messageRefLabel(t, m)}
      onPress={() => router.push(chatHref(m.channelId, m.threadId, m.id))}
      style={[styles.ref, { backgroundColor: c.sunken, color: c.ink }]}
    >
      {messageRefWords(t, m)}
      {icon}
    </RNText>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "600", borderRadius: 4 },
});
