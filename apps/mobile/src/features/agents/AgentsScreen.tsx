import { useDms, useWorkingRuns } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Chip, EmptyState, LargeTitleScreen, ListRow, PixelOrbit, SectionHeader, Text } from "@/ui";
import { useOpenDm } from "../new/useOpenDm";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { agoOf, type TeamLine, teamLines } from "./logic";
import { agoText, workTitle } from "./work";

/** Rows whose agent moves (a long team stays light). */
const LIVE_ROWS = 8;

/**
 * Agentes (MobileHomeAgentes.html, Recomendada): the team in Conversas' rows. "Trabalhando agora" (moving,
 * since when, and what each one is on, with the pixel orbit), then "Livres" (its last conversation and when).
 * Tapping an agent opens the direct conversation with it (its profile is in that conversation's bar; one that
 * doesn't talk to you opens its profile); "Novo agente" at the end.
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const header = useTabHeader();
  const openDm = useOpenDm();
  const orgId = useOrgId();
  const runs = useWorkingRuns(orgId);
  const dms = useDms(orgId);
  const work = useWorkingNow();
  const { working, free } = teamLines(dir.agents, work, dms.data ?? []);
  const pull = usePullRefresh(() => Promise.allSettled([runs.refetch(), dms.refetch()]));
  const total = dir.agents.length;
  return (
    <LargeTitleScreen
      title={t("mobile.agents.title")}
      subtitle={t("mobile.agents.subtitle", { count: total, working: working.length })}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {dir.loading ? null : total === 0 ? <EmptyState title={t("mobile.agents.empty")} sky /> : null}
      {working.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.home.workingNow")} count={working.length} />
          {working.map((l, i) => (
            <AgentRow key={l.agent.id} line={l} divider={i > 0} live={i < LIVE_ROWS} onOpen={openDm} />
          ))}
        </>
      ) : null}
      {free.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.agents.freeSection")} count={free.length} />
          {free.map((l, i) => (
            <AgentRow key={l.agent.id} line={l} divider={i > 0} live={working.length + i < LIVE_ROWS} onOpen={openDm} />
          ))}
        </>
      ) : null}
      <Pressable
        onPress={() => router.push("/new-agent")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.newRow, pressed && { backgroundColor: c.sunken }]}
      >
        <Tile icon="plus" size={36} />
        <Text variant="callout" tone="ink2" style={styles.bold}>
          {t("mobile.agents.new")}
        </Text>
      </Pressable>
    </LargeTitleScreen>
  );
}

/** One agent (`.arow`): its body, the name and role, since when or its last conversation, then what it is on or said. */
function AgentRow({
  line: l,
  divider,
  live,
  onOpen,
}: {
  line: TeamLine;
  divider: boolean;
  live: boolean;
  onOpen: ReturnType<typeof useOpenDm>;
}) {
  const { t } = useTranslation();
  const when = useWhen();
  const now = useNow();
  const { agent: a, work: w } = l;
  const time = l.at ? (w ? agoText(t, agoOf(l.at, now)) : when.short(l.at)) : null;
  const sub = w ? workTitle(t, w) : (l.preview ?? "");
  const open = () => {
    if (a.canTalk === false) router.push(`/agent/${a.id}`);
    else void onOpen({ agentId: a.id });
  };
  return (
    <ListRow
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={[
        w ? t("mobile.agents.workingLabel", { name: a.name }) : a.name,
        a.role.trim() || null,
        time,
        sub || null,
      ]
        .filter(Boolean)
        .join(", ")}
      divider={divider}
      leading={<AgentFace agentId={a.id} size={50} mode={w ? "run" : "idle"} live={live} />}
      title={
        <View style={styles.l1}>
          <Text variant="title" numberOfLines={1} style={styles.name}>
            {a.name}
          </Text>
          {a.role.trim() ? (
            <View style={styles.role}>
              <Chip label={a.role.trim()} />
            </View>
          ) : null}
        </View>
      }
      time={time}
      sub={
        w ? (
          <View style={styles.work}>
            <PixelOrbit color={agentLook(a).color} size={12} />
            <Text variant="small" tone="ink2" numberOfLines={1} style={[styles.medium, styles.shrink]}>
              {sub}
            </Text>
          </View>
        ) : sub ? (
          <Text variant="small" tone="muted" numberOfLines={1}>
            {sub}
          </Text>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  l1: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  name: { flexShrink: 0, maxWidth: "70%" },
  role: { flexShrink: 1, minWidth: 0 },
  work: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0, marginTop: 2 },
  medium: { fontWeight: "500" },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingLeft: 22,
    paddingRight: 16,
    marginTop: 4,
  },
});
