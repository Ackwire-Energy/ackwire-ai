import type { Message } from "@agenteschat/client";
import { type ConsultNoticeFold, pairItemOf } from "@agenteschat/client/lib/consult-group";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import { consultationOfNotice, stoppedNoticeOf } from "@agenteschat/client/lib/notices";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { LineIcon, Text } from "@/ui";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { ConsultPairRow } from "./ConsultGroup";
import { eventLineOf } from "./logic";
import { MessageText } from "./MessageText";
import { StoppedLine } from "./StoppedLine";

/**
 * An automatic line of the conversation, not a voice (the web's `NoticeLine`): what reached an agent's
 * conversation ("Rotina «Sentry» entregou um relatório" while the agent hasn't told it yet, "Infra
 * respondeu", "Nota de Dev", "Chegou o resultado que Ada esperava"). Quiet like `IssueTakenLine`; the
 * text opens under it on "Ver". The agent's own reply, if it has one, follows as a normal message.
 * An answer the reply that asked shows (`ConsultGroup`, `fold`): nothing when that reply is close, the two agents'
 * pair row when it is farther up (a tap opens their conversation).
 * A task a person stopped has its own line (`StoppedLine`).
 */
export function EventLine({ message, fold }: { message: Message; fold?: ConsultNoticeFold }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const [open, setOpen] = useState(false);
  // A person stopped one of the agent's tasks (ADR 0128): its own line, with the reason, or a way to give one.
  const stopped = stoppedNoticeOf(message.meta);
  if (stopped) return <StoppedLine message={message} notice={stopped} />;
  if (fold?.fold === "hide") return null;
  // Farther up than the reply that asked: the same pair row where the answer arrived, opening their conversation.
  if (fold?.fold === "line")
    return (
      <ConsultPairRow askerId={fold.consultation.agentId} channelId={message.channelId} items={[fold.consultation]} />
    );
  // An answer from another agent that carries the consultation, its reply not here: the same pair row a reply
  // has (who asked whom), never the text written for the agent; a tap opens what they said.
  const consulted = consultationOfNotice(message.meta);
  const line = eventLineOf(
    message,
    {
      author: dir.nameOf(message.author) || t("channel.unknownAgent"),
      agentByHandle: (handle) => agentsByAnyHandle(dir.agents).get(handle.toLowerCase())?.name ?? null,
    },
    when,
  );
  if (consulted)
    return (
      <ConsultPairRow
        askerId={consulted.askerId}
        channelId={message.channelId}
        items={[pairItemOf(consulted.consultation)]}
      />
    );
  if (!line) return null;
  return (
    <View style={styles.line}>
      <View style={styles.head}>
        <LineIcon name={line.icon} size={13} color={c.faint} variant="caption" />
        <Text variant="caption" tone="faint" style={styles.grow}>
          {t(line.key, line.values)} · {when.time(message.createdAt)}
          {line.text ? (
            <>
              {" · "}
              <Text
                variant="caption"
                tone="muted"
                style={styles.toggle}
                onPress={() => setOpen((o) => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                suppressHighlighting
              >
                {open ? t("chat.notice.hide") : t("chat.notice.show")}
              </Text>
            </>
          ) : null}
        </Text>
      </View>
      {open && line.text ? (
        <View style={[styles.body, { borderLeftColor: c.line }]}>
          <MessageText body={line.text} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Aligned with the messages' words (MessageRow: 14 + 34 avatar + 11 gap ≈ 56), like `IssueTakenLine`.
  line: { marginVertical: 4, paddingLeft: 56, paddingRight: 16 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, flexShrink: 1 },
  toggle: { fontWeight: "600" },
  // The text itself, under the line, aligned with the words (not the icon).
  body: { marginTop: 4, marginLeft: 19, paddingLeft: 10, borderLeftWidth: 2 },
});
