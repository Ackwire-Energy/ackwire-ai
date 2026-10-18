import { type Message, useIssue } from "@agenteschat/client";
import { type IssueWorkRef, issueTakenOf } from "@agenteschat/client/lib/issues";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { StateChip } from "../issues/parts";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { tapHaptic, useSurface } from "../shared/parts";

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
  const open = () => {
    tapHaptic();
    router.push(`/issues/${work.number}`);
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${t("chat.issueWork.label")}: #${work.number} ${current?.title ?? work.title}`}
      accessibilityHint={t("chat.issueWork.view")}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <View style={styles.head}>
        <View style={[styles.ic, { backgroundColor: c.sunken }]}>
          <Icon name="issue" size={15} color={c.ink2} />
        </View>
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
export function IssueTakenLine({ message }: { message: Message }) {
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
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
    >
      <Icon name="issue" size={13} color={c.faint} />
      <Text variant="caption" tone="faint" style={styles.grow}>
        {t("chat.issueWork.taken", { name })}{" "}
        <Text variant="caption" tone="muted">
          #{taken.number} · {taken.title}
        </Text>{" "}
        · {when.time(message.createdAt)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 8, padding: 14, borderRadius: 20, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  ic: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, flexShrink: 1 },
  title: { fontWeight: "600" },
  foot: { flexDirection: "row", alignItems: "center", gap: 4 },
  bold: { fontWeight: "600" },
  pressed: { opacity: 0.85 },
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginVertical: 4,
    paddingLeft: 56,
    paddingRight: 16,
  },
});
