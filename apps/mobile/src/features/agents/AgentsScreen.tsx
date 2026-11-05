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
import { RefreshControl, StyleSheet, View } from "react-native";
import { STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { EmptyState, Icon, LargeTitleScreen, LIST_PREVIEW, ListRow, PixelOrbit, SectionHeader, Text } from "@/ui";
import { CollapsibleSection, useCollapsedSections } from "../chats/HomeSection";
import { usePins } from "../chats/pins";
import { useMachineOutages } from "../outages/queries";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { usePresenceOf } from "../status/hooks";
import { useTasksToday } from "../task-manager/hooks";
import { openAgentDelete } from "./DeleteAgentScreen";
import { agoOf, freeSections, plainRole, type TeamLine, teamLines } from "./logic";
import { agoText, workTitle } from "./work";

/** Rows whose agent moves (a long team stays light). */
const LIVE_ROWS = 8;
/** While Agentes is on screen, how often it asks whether the task manager is there (the manager itself: seconds). */
const TASKS_POLL_MS = 15_000;

/**
 * Agentes: the team in Conversas' rows, who needs you first.
 * "Esperando você" (the exact request and since when), "Trabalhando agora" (what each one is on, since when,
 * with the pixel orbit), then "Livres" (its role in plain words, and when you last talked; first, dozing, the
 * ones waiting for their offline computer: "Esperando o MacBook Air"), split by the workspace's groups of agents
 * when it has some. Tapping an agent opens its profile (Conversar is one tap there); a new agent is the header's "+".
 * Agents move between groups on the web. The task manager (ADR 0128) opens from the first header of who is at work
 * ("Trabalhando agora", else the free ones'), as Meu Início's "Ver todos ›".
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const header = useTabHeader();
  const orgId = useOrgId();
  const org = useOrg().org;
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
  // A server without the task manager shows no way into it.
  const tasks = useTasksToday({ pollMs: TASKS_POLL_MS });
  const tasksAction =
    total > 0 && !(tasks.isError && !tasks.data)
      ? { label: t("taskManager.title"), onPress: () => router.push("/task-manager") }
      : null;
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
          <SectionHeader title={t("mobile.home.workingNow")} count={working.length} action={tasksAction} />
          {working.map((l, i) => (
            <AgentRow key={l.agent.id} line={l} divider={i > 0} live={waiting.length + i < LIVE_ROWS} />
          ))}
        </>
      ) : null}
      {free.length > 0 && !groups.isPending ? (
        <FreeSections
          free={free}
          groups={groups.data ?? []}
          before={busy}
          action={working.length > 0 ? null : tasksAction}
        />
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
    </LargeTitleScreen>
  );
}

/**
 * Livres by group: the agents in no group under "Livres" ("Sem grupo" once there are groups), then each group, which
 * collapses (remembered on this phone, for every workspace). Mounted once the groups are in, so Livres doesn't show
 * whole and then split.
 */
function FreeSections({
  free,
  groups,
  before,
  action,
}: {
  free: TeamLine[];
  groups: AgentGroup[];
  before: number;
  /** The task manager's way in, on the free agents' header when nobody works. */
  action: { label: string; onPress: () => void } | null;
}) {
  const { t } = useTranslation();
  const { collapsed, toggle } = useCollapsedSections<string>(STORED.agentGroupsCollapsed, null);
  const pins = usePins();
  let shown = before;
  return (
    <>
      {freeSections(free, groups, pins.pins.agents).map(({ group, lines, pinnedCount }) => {
        const first = shown;
        shown += lines.length;
        const rows = lines.map((l, i) => (
          <AgentRow key={l.agent.id} line={l} divider={i > 0} live={first + i < LIVE_ROWS} pinned={i < pinnedCount} />
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
              action={action}
            />
            {rows}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * One agent (`.arow`): its body with its presence badge, its name alone, then what it needs from you (the exact
 * request), what it is on (its line when it has one, ADR 0084; since when), or what it does in plain words, else its
 * role (when you last talked). Pinned ones come first, with no mark.
 */
function AgentRow({
  line: l,
  divider,
  live,
  pinned = false,
}: {
  line: TeamLine;
  divider: boolean;
  live: boolean;
  /** On top of Livres ("Fixar no topo"): said to screen readers; the order shows it. */
  pinned?: boolean;
}) {
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
            (a.role.trim() ||
              (l.preview || l.previewMedia
                ? previewBody(t, l.preview ?? "", l.previewMeta ?? null, l.previewMedia)
                : "")));
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
        pinned ? t("sidebarPins.pinned") : null,
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
      title={a.name}
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
  work: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0, marginTop: 2 },
  medium: { fontWeight: "500" },
  shrink: { flexShrink: 1 },
});
