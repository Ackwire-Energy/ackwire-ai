import { type Issue, type IssueActivity, keys, useApi, useIssueAction, useIssueActivity } from "@agenteschat/client";
import { whenAt } from "@agenteschat/client/lib/format";
import { issueEventText } from "@agenteschat/client/lib/issues";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chip, Composer, Icon, type IconName, SectionHeader, Text, useToast } from "@/ui";
import { MessageText } from "../chat/MessageText";
import { MessageFiles } from "../files/MessageFiles";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { ActionList, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";

const eventIcon = (a: IssueActivity): IconName =>
  a.event === "agent_asked" ? "agent" : a.textCode?.startsWith("forum_") ? "chat" : "clock";

/** "Atividade": what happened to the task, in order, with the comments between the events. */
export function IssueActivityFeed({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const orgId = useOrgId();
  const activity = useIssueActivity(orgId, issue.id);
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

/** The box at the bottom: a comment goes at once; "+" sends a photo or a file as a comment of its own. */
export function IssueComposer({ issue, onSent }: { issue: Issue; onSent: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const sheet = useSheet();
  const toast = useToast();
  const action = useIssueAction(orgId);
  const comment = (text: string, attachmentIds?: string[]) =>
    action.mutate(
      { type: "comment", id: issue.id, text, ...(attachmentIds ? { attachmentIds } : {}) },
      {
        onSuccess: () => {
          successHaptic();
          void qc.invalidateQueries({ queryKey: keys.issueActivity(orgId, issue.id) }).then(onSent);
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  const upload = async (file: { uri: string; name: string; type: string }) => {
    toast({ title: t("mobile.chat.uploading"), icon: "file" });
    try {
      // React Native's FormData sends `{ uri, name, type }` as a file part.
      const asFile = file as unknown as Parameters<typeof api.artifacts.upload>[1];
      const saved = await api.artifacts.upload(orgId, asFile, issue.channelId ? { channelId: issue.channelId } : {});
      comment("", [saved.id]);
    } catch {
      toast({ title: t("mobile.chat.uploadFailed"), icon: "x" });
    }
  };
  const photo = async () => {
    sheet.close();
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.8 });
    const a = res.canceled ? null : res.assets[0];
    if (a)
      await upload({
        uri: a.uri,
        name: a.fileName ?? (a.type === "video" ? "video.mp4" : "photo.jpg"),
        type: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
      });
  };
  const file = async () => {
    sheet.close();
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? null : res.assets[0];
    if (a) await upload({ uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream" });
  };
  return (
    <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.dock}>
      <View style={[styles.box, { paddingBottom: insets.bottom + 8 }]}>
        <LinearGradient
          pointerEvents="none"
          colors={[`${c.bg}00`, c.bg]}
          locations={[0, 0.3]}
          style={StyleSheet.absoluteFill}
        />
        <Composer
          placeholder={t("mobile.issues.commentHere")}
          onSend={(text) => comment(text)}
          onPlus={() =>
            sheet.open(
              <ActionList
                items={[
                  { key: "photos", icon: "photos", label: t("mobile.plus.photos"), onPress: () => void photo() },
                  { key: "file", icon: "file", label: t("mobile.plus.file"), onPress: () => void file() },
                ]}
              />,
            )
          }
        />
      </View>
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  none: { paddingHorizontal: 20 },
  event: { flexDirection: "row", alignItems: "flex-start", gap: 9, paddingHorizontal: 20, paddingVertical: 6 },
  comment: { flexDirection: "row", gap: 10, paddingHorizontal: 20, paddingVertical: 9 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  box: { paddingHorizontal: 12, paddingTop: 16 },
});
