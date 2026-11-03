import { useCreateDashboard, useMembers } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedHeader, GroupedList, GroupedRow, useTheme, useToast } from "@/ui";
import { boardHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { useDirectory, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { type AudienceDraft, audienceDraftOf, audienceReady, shareInputOf } from "./logic";
import { AgentPicker, AudienceFields } from "./parts";

/** The longest name and brief the server takes (ADR 0134). */
const TITLE_MAX = 80;
const BRIEF_MAX = 2000;

/**
 * "New dashboard", pushed (ADR 0134): its name, how to start (blank, or an agent builds its widgets and routines from a
 * brief, in the person's conversation with it), who sees it and who edits it. "Create" in the bar opens the new board.
 */
export function NewBoardScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const members = useMembers(orgId);
  const create = useCreateDashboard(orgId);
  const agents = useMemo(() => dir.agents.filter((a) => canTalk(a)), [dir.agents]);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState<"blank" | "agent">("blank");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<AudienceDraft>(() => audienceDraftOf(null));
  useEffect(() => {
    const first = agents[0];
    if (!agentId && first) setAgentId(first.id);
  }, [agentId, agents]);
  const withAgent = start === "agent";
  const ready =
    title.trim().length > 0 &&
    audienceReady(draft) &&
    (!withAgent || (Boolean(agentId) && brief.trim().length > 0)) &&
    !create.isPending;
  const submit = () => {
    if (!ready) return;
    const name = title.trim();
    create.mutate(
      {
        title: name,
        ...shareInputOf(draft),
        ...(withAgent && agentId ? { start: { agentId, brief: brief.trim() } } : {}),
      },
      {
        onSuccess: (board) => {
          successHaptic();
          // "Ask an agent": the brief went to its conversation, where it builds the widgets (ADR 0134).
          const builder = board.startedIn && agentId ? agentId : null;
          toast(
            builder
              ? {
                  title: t("dashboards.create.started", { name: dir.agentById.get(builder)?.name ?? "", title: name }),
                  agentId: builder,
                }
              : { title: t("dashboards.create.created", { title: name }) },
          );
          router.replace(boardHref(board.id));
        },
        onError: failed,
      },
    );
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.create.title")}
        solid={false}
        grouped
        action={{ label: t("mobile.dashboards.create"), disabled: !ready, onPress: submit }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 28 + insets.bottom }]}
      >
        <GroupedHeader>{t("dashboards.create.name")}</GroupedHeader>
        <TextArea
          value={title}
          onChangeText={setTitle}
          placeholder={t("dashboards.create.namePlaceholder")}
          accessibilityLabel={t("dashboards.create.name")}
          multiline={false}
          minHeight={50}
          maxLength={TITLE_MAX}
          returnKeyType="done"
          autoFocus
        />

        <GroupedHeader>{t("dashboards.create.start")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            icon="chart"
            label={t("dashboards.create.blank")}
            sub={t("dashboards.create.blankHint")}
            checked={!withAgent}
            onPress={() => setStart("blank")}
          />
          <GroupedRow
            icon="bolt"
            label={t("dashboards.create.agent")}
            sub={t("dashboards.create.agentHint")}
            checked={withAgent}
            disabled={agents.length === 0}
            onPress={() => setStart("agent")}
          />
        </GroupedList>
        {withAgent ? (
          <>
            <View style={styles.gap} />
            <View style={styles.bleed}>
              <AgentPicker agents={agents} value={agentId} onChange={setAgentId} />
            </View>
            <View style={styles.gap} />
            <TextArea
              value={brief}
              onChangeText={setBrief}
              placeholder={t("dashboards.create.briefPlaceholder")}
              accessibilityLabel={t("dashboards.create.agent")}
              maxLength={BRIEF_MAX}
              minHeight={84}
            />
          </>
        ) : null}

        <AudienceFields draft={draft} onChange={setDraft} members={members.data?.length ?? 0} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  gap: { height: 10 },
  bleed: { marginHorizontal: -16 },
});
