import type { Message } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { eventLineOf } from "./logic";
import { MessageText } from "./MessageText";

/**
 * An automatic line of the conversation, not a voice (the web's `NoticeLine` / `RoutineRanLine`):
 * what reached an agent's conversation ("Rotina «Sentry» entregou um relatório", "@Infra respondeu",
 * "Nota de @Dev", "Chegou o resultado que Ada esperava") or a routine that ran in the background
 * ("Rotina «Bom dia» rodou", never as the person who created it). Quiet like `IssueTakenLine`; the
 * text opens under it on "Ver". The agent's own reply, if it has one, follows as a normal message.
 */
export function EventLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const [open, setOpen] = useState(false);
  const line = eventLineOf(message, {
    author: dir.nameOf(message.author) || t("channel.unknownAgent"),
    agentByHandle: (handle) => dir.agents.find((a) => a.handle.toLowerCase() === handle.toLowerCase())?.name ?? null,
  });
  if (!line) return null;
  const labels =
    line.kind === "routine"
      ? { show: t("channel.routineShow"), hide: t("channel.routineHide") }
      : { show: t("chat.notice.show"), hide: t("chat.notice.hide") };
  return (
    <View style={styles.line}>
      <View style={styles.head}>
        <Icon name={line.icon} size={13} color={c.faint} />
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
                {open ? labels.hide : labels.show}
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
