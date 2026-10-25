import { useApprovals, useDms, useWorkingRuns } from "@agenteschat/client";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Chip, EmptyState, Icon, LargeTitleScreen, LIST_PREVIEW, ListRow, PixelOrbit, SectionHeader, Text } from "@/ui";
import { useMachineOutages } from "../outages/queries";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { agoOf, plainRole, type TeamLine, teamLines } from "./logic";
import { agoText, workTitle } from "./work";

/** Rows whose agent moves (a long team stays light). */
const LIVE_ROWS = 8;

/**
 * Agentes: the team in Conversas' rows, who needs you first.
 * "Esperando você" (the exact request and since when), "Trabalhando agora" (what each one is on, since when,
 * with the pixel orbit), then "Livres" (its role in plain words, and when you last talked; first, dozing, the
 * ones waiting for their offline computer: "Esperando o MacBook Air"). Tapping an agent
 * opens its profile (Conversar is one tap there); "Novo agente" at the end.
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const header = useTabHeader();
  const orgId = useOrgId();
  const runs = useWorkingRuns(orgId);
  const dms = useDms(orgId);
  const approvals = useApprovals(orgId);
  const work = useWorkingNow();
  const asking = useWaitingApprovals();
  const outages = useMachineOutages();
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  const { waiting, working, free } = teamLines(dir.agents, work, dms.data ?? [], asking, offline);
  const busy = waiting.length + working.length;
  const pull = usePullRefresh(() =>
    Promise.allSettled([runs.refetch(), dms.refetch(), approvals.refetch(), outages.refetch()]),
  );
  const total = dir.agents.length;
  return (
    <LargeTitleScreen
      title={t("mobile.agents.title")}
      subtitle={t("mobile.agents.subtitle", { count: total, working: working.length })}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {dir.loading ? null : total === 0 ? <EmptyState title={t("mobile.agents.empty")} sky /> : null}
      {waiting.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.intentAgents.waitingSection")} count={waiting.length} />
          {waiting.map((l, i) => (
            <AgentRow key={l.agent.id} line={l} divider={i > 0} live={i < LIVE_ROWS} />
          ))}
        </>
      ) : null}
      {working.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.home.workingNow")} count={working.length} />
          {working.map((l, i) => (
            <AgentRow key={l.agent.id} line={l} divider={i > 0} live={waiting.length + i < LIVE_ROWS} />
          ))}
        </>
      ) : null}
      {free.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.agents.freeSection")} count={free.length} />
          {free.map((l, i) => (
            <AgentRow key={l.agent.id} line={l} divider={i > 0} live={busy + i < LIVE_ROWS} />
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

/**
 * One agent (`.arow`): its body, the name and role, then what it needs from you (the exact request), what it is
 * on (since when), or its role in plain words (when you last talked).
 */
function AgentRow({ line: l, divider, live }: { line: TeamLine; divider: boolean; live: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const when = useWhen();
  const now = useNow();
  const { agent: a, work: w, approval, computer } = l;
  const busy = Boolean(approval || w);
  const time = l.at ? (busy ? agoText(t, agoOf(l.at, now)) : when.short(l.at)) : null;
  const sub = approval
    ? l.waitingCount > 1
      ? t("mobile.intentAgents.waitingMore", { title: approval.title, count: l.waitingCount - 1 })
      : t("mobile.intentAgents.waitingLine", { title: approval.title })
    : w
      ? workTitle(t, w)
      : computer !== undefined
        ? t("mobile.outage.rowWaiting", { computer })
        : (plainRole(a.instructions) ?? (l.preview ? previewBody(t, l.preview, l.previewMeta ?? null) : ""));
  return (
    <ListRow
      onPress={() => router.push(`/agent/${a.id}`)}
      accessibilityRole="button"
      accessibilityLabel={[
        approval
          ? t("mobile.intentAgents.waitingLabel", { name: a.name })
          : w
            ? t("mobile.agents.workingLabel", { name: a.name })
            : computer !== undefined
              ? t("mobile.outage.rowWaitingLabel", { name: a.name, computer })
              : a.name,
        a.role.trim() || null,
        time,
        computer !== undefined ? null : sub || null,
      ]
        .filter(Boolean)
        .join(", ")}
      divider={divider}
      leading={
        <AgentFace agentId={a.id} size={50} mode={w ? "run" : computer !== undefined ? "rest" : "idle"} live={live} />
      }
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
        approval ? (
          <View style={styles.work}>
            <Icon name="wait" size={13} color={c.amber} />
            <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.medium, styles.shrink]}>
              {sub}
            </Text>
          </View>
        ) : w ? (
          <View style={styles.work}>
            <PixelOrbit color={agentLook(a).color} size={12} />
            <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.medium, styles.shrink]}>
              {sub}
            </Text>
          </View>
        ) : computer !== undefined ? (
          <View style={styles.work}>
            <Icon name="clock" size={13} color={c.muted} />
            <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
              {sub}
            </Text>
          </View>
        ) : sub ? (
          <Text variant="small" tone="muted" numberOfLines={1} style={LIST_PREVIEW}>
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
