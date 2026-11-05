import { type Issue, type IssueActivity, useIssueActivity, useIssueLive } from "@agenteschat/client";
import { whenAt } from "@agenteschat/client/lib/format";
import { issueEventText } from "@agenteschat/client/lib/issues";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Chip, Icon, type IconName, SectionHeader, Text } from "@/ui";
import { MessageText } from "../chat/MessageText";
import { MessageFiles } from "../files/MessageFiles";
import { Face } from "../shared/Face";
import { useColors, useConnection, useDirectory, useOrgId } from "../shared/hooks";

const eventIcon = (a: IssueActivity): IconName => (a.event === "agent_asked" ? "agent" : "clock");

/** "Atividade": what happened to the task, in order, with the comments between the events. */
export function IssueActivityFeed({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const orgId = useOrgId();
  const activity = useIssueActivity(orgId, issue.id);
  // A comment or a change from someone else (a person, an agent) shows up while the task is open.
  useIssueLive(orgId, useConnection(), issue);
  const list = activity.data ?? [];
  const when = (iso: string) => whenAt(t, i18n.language, iso);
  return (
    <>
      <SectionHeader title={t("issues.activity")} count={list.length} />
      {activity.isSuccess && list.length === 0 ? (
        <Text variant="subhead" tone="faint" style={styles.none}>
          {t("issues.noActivity")}
        </Text>
      ) : null}
      {list.map((a) =>
        a.kind === "event" ? (
          <View key={a.id} style={styles.event}>
            <Icon name={eventIcon(a)} size={15} color={c.faint} />
            <Text variant="small" tone="muted" style={styles.grow}>
              <Text variant="small" tone="ink2" style={styles.bold}>
                {dir.nameOf(a.author)}
              </Text>
              {` ${issueEventText(t, a)} · ${when(a.createdAt)}`}
            </Text>
            {a.auto ? <Chip label={t("issues.auto")} /> : null}
          </View>
        ) : (
          <View key={a.id} style={styles.comment}>
            <Face who={a.author} size={34} live={false} />
            <View style={styles.grow}>
              <Text variant="callout" style={styles.bold}>
                {dir.nameOf(a.author)}{" "}
                <Text variant="footnote" tone="faint">
                  {when(a.createdAt)}
                </Text>
              </Text>
              {a.text ? <MessageText body={a.text} /> : null}
              {a.attachments?.length ? (
                // The chat's files: a print at its own shape (tap opens the viewer), other files as a card.
                <MessageFiles files={a.attachments.map((f) => ({ id: f.id, title: f.title, deleted: false }))} />
              ) : null}
            </View>
          </View>
        ),
      )}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  none: { paddingHorizontal: 20 },
  event: { flexDirection: "row", alignItems: "flex-start", gap: 9, paddingHorizontal: 20, paddingVertical: 6 },
  comment: { flexDirection: "row", gap: 10, paddingHorizontal: 20, paddingVertical: 9 },
});
