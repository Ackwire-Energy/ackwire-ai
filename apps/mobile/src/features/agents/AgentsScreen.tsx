import {
  type AgentGroup,
  useAgentGroups,
  useAiStatus,
  useApprovals,
  useDms,
  useFormerAgents,
  useWorkingRuns,
} from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { Chip, EmptyState, Icon, LargeTitleScreen, LIST_PREVIEW, ListRow, PixelOrbit, SectionHeader, Text } from "@/ui";
import { CollapsibleSection, useCollapsedSections } from "../chats/HomeSection";
import { useMachineOutages } from "../outages/queries";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { usePresenceOf } from "../status/hooks";
import { TaskManagerEntry } from "../task-manager/TaskManagerEntry";
import { openAgentDelete } from "./DeleteAgentScreen";
import { agoOf, freeSections, plainRole, type TeamLine, teamLines } from "./logic";
import { agoText, workTitle } from "./work";

/** Rows whose agent moves (a long team stays light). */
const LIVE_ROWS = 8;

/**
 * Agentes: the team in Conversas' rows, who needs you first.
 * "Esperando você" (the exact request and since when), "Trabalhando agora" (what each one is on, since when,
 * with the pixel orbit), then "Livres" (its role in plain words, and when you last talked; first, dozing, the
 * ones waiting for their offline computer: "Esperando o MacBook Air"), split by the workspace's groups of agents
 * when it has some. Tapping an agent opens its profile (Conversar is one tap there); "Novo agente" at the end, for who
 * may create one. Agents move between groups on the web. Above them, the way into the task manager (ADR 0127).
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const header = useTabHeader();
  const orgId = useOrgId();
  const org = useOrg().org;
  const createsAgents = can(org, "create_agents");
  const runs = useWorkingRuns(orgId);
  const dms = useDms(orgId);
  const approvals = useApprovals(orgId);
  const work = useWorkingNow();
  const asking = useWaitingApprovals();
  const outages = useMachineOutages();
  const groups = useAgentGroups(orgId);
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  const agents = dir.agents.filter((a) => listsAgent(org, a));
  const { waiting, working, free } = teamLines(agents, work, dms.data ?? [], asking, offline);
  const busy = waiting.length + working.length;
  const pull = usePullRefresh(() =>
    Promise.allSettled([runs.refetch(), dms.refetch(), approvals.refetch(), outages.refetch(), groups.refetch()]),
  );
  const total = agents.length;
  // Archived agents have no profile: admins delete them for good from here (ADR 0082).
  const admin = can(org, "manage_agents");
  const archived = (useFormerAgents(orgId).data ?? []).filter((a) => admin && !a.deleted);
  return (
    <LargeTitleScreen
      title={t("mobile.agents.title")}
      subtitle={t("mobile.agents.subtitle", { count: total, working: working.length })}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {dir.loading ? null : dir.agents.length === 0 ? (
        <EmptyState title={t("mobile.agents.empty")} sky />
      ) : total === 0 ? (
        <EmptyState title={t("mobile.agents.noneForYou")} subtitle={t("mobile.agents.noneForYouHint")} sky />
      ) : null}
      {/* What every agent is doing, task by task, and a way to stop it (ADR 0127). */}
      {total > 0 ? <TaskManagerEntry /> : null}
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
      {free.length > 0 && !groups.isPending ? (
        <FreeSections free={free} groups={groups.data ?? []} before={busy} />
      ) : null}
      {archived.length > 0 ? (
        <>
          <SectionHeader title={t("team.archived")} count={archived.length} />
          {archived.map((a, i) => (
            <ListRow
              key={a.id}
              onPress={() => openAgentDelete(a.id)}
              accessibilityRole="button"
              accessibilityLabel={t("agentPage.delete.action", agentGrammar(a.name))}
              divider={i > 0}
              leading={<AgentFace agentId={a.id} size={50} mode="rest" live={false} />}
              title={a.name}
              sub={a.role.trim() || null}
            />
          ))}
        </>
      ) : null}
      {createsAgents ? (
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
      ) : null}
    </LargeTitleScreen>
  );
}

/**
 * Livres by group: the agents in no group under "Livres" ("Sem grupo" once there are groups), then each group, which
 * collapses (remembered on this phone, for every workspace). Mounted once the groups are in, so Livres doesn't show
 * whole and then split.
 */
function FreeSections({ free, groups, before }: { free: TeamLine[]; groups: AgentGroup[]; before: number }) {
  const { t } = useTranslation();
  const { collapsed, toggle } = useCollapsedSections<string>(STORED.agentGroupsCollapsed, null);
  let shown = before;
  return (
    <>
      {freeSections(free, groups).map(({ group, lines }) => {
        const first = shown;
        shown += lines.length;
        const rows = lines.map((l, i) => (
          <AgentRow key={l.agent.id} line={l} divider={i > 0} live={first + i < LIVE_ROWS} />
        ));
        return group ? (
          <CollapsibleSection
            key={group.id}
            title={group.name}
            count={lines.length}
            collapsed={collapsed.includes(group.id)}
            onToggle={() => toggle(group.id)}
          >
            {rows}
          </CollapsibleSection>
        ) : (
          <Fragment key="free">
            <SectionHeader
              title={groups.length > 0 ? t("mobile.agents.noGroupSection") : t("mobile.agents.freeSection")}
              count={lines.length}
            />
            {rows}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * One agent (`.arow`): its body with its presence badge, the name and role, then what it needs from you (the exact
 * request), what it is on (its line when it has one, ADR 0084; since when), or its role in plain words (when you
 * last talked).
 */
function AgentRow({ line: l, divider, live }: { line: TeamLine; divider: boolean; live: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const when = useWhen();
  const now = useNow();
  const { agent: a, work: w, approval, computer } = l;
  const ai = useAiStatus(useOrgId());
  // An agent with nothing to think with says so where its role would be (the web's "Sem IA").
  const noAi = !approval && !w && computer === undefined && aiStateOf(ai.data, a.id) === "no_ai";
  const busy = Boolean(approval || w);
  const line = usePresenceOf().agent(a.id)?.line ?? null;
  const time = l.at ? (busy ? agoText(t, agoOf(l.at, now)) : when.short(l.at)) : null;
  const sub = approval
    ? l.waitingCount > 1
      ? t("mobile.intentAgents.waitingMore", { title: approval.title, count: l.waitingCount - 1 })
      : t("mobile.intentAgents.waitingLine", { title: approval.title })
    : w
      ? line
        ? line.text
        : workTitle(t, w)
      : computer !== undefined
        ? t("mobile.outage.rowWaiting", { computer })
        : noAi
          ? t("noAi.chip")
          : (plainRole(a.instructions) ??
            (l.preview || l.previewMedia
              ? previewBody(t, l.preview ?? "", l.previewMeta ?? null, l.previewMedia)
              : ""));
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
        <AgentFace
          agentId={a.id}
          size={50}
          mode={w ? "run" : computer !== undefined ? "rest" : "idle"}
          live={live}
          presence
        />
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
        ) : noAi ? (
          <View style={styles.work}>
            <Icon name="bolt" size={13} color={c.amber} />
            <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.medium, styles.shrink]}>
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
  // The name stays whole; a long role gives way (a share of an unsized box measured as almost nothing: "Re…").
  name: { flexShrink: 0 },
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
