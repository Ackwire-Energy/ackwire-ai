import { type Message, useIssue } from "@agenteschat/client";
import { type IssueWorkRef, issueTakenOf } from "@agenteschat/client/lib/issues";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, LineIcon, Text } from "@/ui";
import { StateChip } from "../issues/parts";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { LINE_GAP, LINE_MARK, MSG_TEXT } from "./logic";

/**
 * "Ask Ada to implement" (as on the web): the root of the work thread in the
 * DM is this card ("Você pediu a issue #24", the title, its live state, "Ver
 * issue"); the agent's instructions never show in the chat.
 */
export function IssueWorkCard({ work, authorId }: { work: IssueWorkRef; authorId: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const issue = useIssue(orgId, work.number);
  const current = issue.data?.id === work.issueId ? issue.data : null;
  const asker = authorId && authorId !== meId ? dir.nameOf({ type: "person", id: authorId }) : "";
  return (
    <Pressable
      onPress={() => router.push(`/issues/${work.number}`)}
      accessibilityRole="button"
      accessibilityLabel={`${t("chat.issueWork.label")}: #${work.number} ${current?.title ?? work.title}`}
      accessibilityHint={t("chat.issueWork.view")}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <View style={styles.head}>
        {/* The icon alone: no tile inside the card. */}
        <Icon name="issue" size={15} color={c.ink2} />
        <Text variant="small" tone="muted" style={styles.grow} numberOfLines={1}>
          {asker ? t("chat.issueWork.askedBy", { name: asker }) : t("chat.issueWork.asked")} #{work.number}
        </Text>
        {current ? <StateChip issue={current} /> : null}
      </View>
      <Text variant="callout" tone="ink" style={styles.title} numberOfLines={3}>
        {current?.title ?? work.title}
      </Text>
      <View style={styles.foot}>
        <Text variant="small" tone="ink2" style={styles.bold}>
          {t("chat.issueWork.view")}
        </Text>
        <Icon name="right" size={15} color={c.faint} />
      </View>
    </Pressable>
  );
}

/** Where the issue came from: one quiet line, "Ada pegou a issue #24 · título" (opens the issue). */
export function IssueTakenLine({ message, gap }: { message: Message; gap: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const taken = issueTakenOf(message.meta);
  if (!taken) return null;
  const name = dir.nameOf(message.author);
  return (
    <Pressable
      onPress={() => router.push(`/issues/${taken.number}`)}
      accessibilityRole="link"
      style={({ pressed }) => [styles.line, { marginTop: gap }, pressed && styles.pressed]}
    >
      <LineIcon name="issue" size={LINE_MARK} color={c.faint} variant="small" />
      <Text variant="small" tone="faint" style={styles.grow}>
        {t("chat.issueWork.taken", { name })}{" "}
        <Text variant="small" tone="muted">
          #{taken.number} · {taken.title}
        </Text>{" "}
        · {when.time(message.createdAt)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 20, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, flexShrink: 1 },
  title: { fontWeight: "600" },
  foot: { flexDirection: "row", alignItems: "center", gap: 4 },
  bold: { fontWeight: "600" },
  pressed: { opacity: 0.85 },
  // An event line at the messages' words: the mark, the words in 15/20.
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: LINE_GAP,
    paddingLeft: MSG_TEXT,
    paddingRight: 16,
  },
});
