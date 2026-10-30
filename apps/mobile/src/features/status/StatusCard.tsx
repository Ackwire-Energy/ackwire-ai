import { clearsText } from "@agenteschat/client/lib/presence";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "@/ui";
import { usePresenceOf } from "./hooks";

/**
 * A status in full (ADR 0081), on a profile: its emoji, the line, and under it who wrote it or when it clears. A
 * raised card with one corner cut, like a word said.
 */
export function StatusCard({ emoji, text, note }: { emoji: string | null; text: string; note?: string | undefined }) {
  const { colors: c, shadows } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={[text, note].filter(Boolean).join(", ")}
      style={[styles.card, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
    >
      {emoji ? <Text style={styles.emoji}>{emoji}</Text> : null}
      <View style={styles.grow}>
        <Text variant="body" style={styles.text}>
          {text}
        </Text>
        {note ? (
          <Text variant="footnote" tone="faint">
            {note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A person's status as a card (the ⋯ of a DM with them): the line, and when it clears; nothing without one. */
export function PersonStatusCard({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation();
  const status = usePresenceOf().person(userId)?.status;
  if (!status) return null;
  return (
    <StatusCard
      emoji={status.emoji}
      text={status.text}
      note={status.until ? clearsText(t, i18n.language || "pt-BR", status.until) : t("presence.untilChanged")}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 5,
  },
  emoji: { fontSize: 20, lineHeight: 24 },
  grow: { flex: 1, minWidth: 0 },
  text: { fontWeight: "500" },
});
