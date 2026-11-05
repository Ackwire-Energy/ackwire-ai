import { type TeamAgent, useAgentGroups, useChannels, useMembers, useTeam } from "@agenteschat/client";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { ListRow, SectionHeader, Segmented, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { type TeamView, teamSections } from "./logic";

const VIEWS: TeamView[] = ["list", "chart", "map"];

/**
 * Equipe on the phone (ADR 0148): the web's Lista, Organograma and Mapa as sections (by setor, by the person each
 * agent reports to, by channel), each setor with its lead and substitute. Editing setores, the map's drag and
 * Governança e uso are on the web.
 */
export function TeamScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const team = useTeam(orgId);
  const groups = useAgentGroups(orgId);
  const channels = useChannels(orgId);
  const members = useMembers(orgId);
  const [view, setView] = useState<TeamView>("list");
  const pull = usePullRefresh(() =>
    Promise.allSettled([team.refetch(), groups.refetch(), channels.refetch(), members.refetch()]),
  );
  const lodi = rightHandOf(dir.agents);
  const owner = (a: TeamAgent) => (a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined);
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name;
  const sections = teamSections(view, {
    agents: team.data?.agents ?? [],
    groups: groups.data ?? [],
    members: members.data ?? [],
    channels: channels.data ?? [],
    rightHandId: lodi?.id ?? null,
  });
  const none =
    view === "list" ? t("agentGroups.none") : view === "chart" ? t("team.noOwner") : t("team.list.noChannel");
  const sub = (a: TeamAgent) => {
    const channel = view === "map" ? undefined : (a.channelIds ?? []).map(channelName).find(Boolean);
    return [a.role.trim(), view === "chart" ? undefined : owner(a), channel && `#${channel}`]
      .filter(Boolean)
      .join(" · ");
  };
  const row = (a: TeamAgent, i: number) => (
    <ListRow
      key={a.id}
      onPress={() => router.push(`/agent/${a.id}`)}
      accessibilityRole="button"
      divider={i > 0}
      leading={<AgentFace agentId={a.id} size={44} mode={a.busy ? "run" : "idle"} live={false} presence />}
      title={a.name}
      sub={sub(a) || null}
    />
  );
  return (
    <PushedLargeTitle
      title={t("team.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.seg}>
        <Segmented
          items={VIEWS.map((v) => ({ key: v, label: t(`team.view.${v}`) }))}
          value={view}
          onChange={(k) => setView(k as TeamView)}
        />
      </View>
      {view === "chart" && lodi ? (
        <>
          <SectionHeader title={t("team.chart.workspace")} />
          <ListRow
            onPress={() => router.push(`/agent/${lodi.id}`)}
            accessibilityRole="button"
            leading={<AgentFace agentId={lodi.id} size={44} mode="idle" live={false} presence />}
            title={lodi.name}
            sub={t("rightHand.label")}
          />
        </>
      ) : null}
      {sections.map((s) => (
        <View key={s.key}>
          <SectionHeader title={s.title ?? none} count={s.agents.length} />
          {s.group ? (
            <Text variant="footnote" tone="muted" style={styles.people}>
              {[
                `${t("team.sectors.leadLabel")}: ${s.lead ?? t("team.sectors.nobody")}`,
                `${t("team.sectors.backupLabel")}: ${s.backup ?? t("team.sectors.nobody")}`,
              ].join(" · ")}
            </Text>
          ) : null}
          {s.agents.map(row)}
        </View>
      ))}
      {view === "map" ? (
        <Text variant="footnote" tone="muted" style={styles.hint}>
          {t("mobile.team.mapHint", { name: lodi?.name ?? "" })}
        </Text>
      ) : null}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  seg: { paddingHorizontal: 16, paddingBottom: 8 },
  hint: { paddingHorizontal: 22, paddingTop: 12 },
  people: { paddingHorizontal: 20, paddingBottom: 6 },
});
