import { type TeamAgent, useAgentGroups, useChannels, useMembers, useTeam } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { chartByPerson, mapColumns, noSectorsCopy } from "@agenteschat/client/lib/team-views";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, EmptyState, ListRow, SectionHeader, Text } from "@/ui";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { Tile, useSurface } from "../shared/parts";
import { teamSections } from "./logic";

/** The org chart's faces: the right hand and the people at 40, their agents at 30, the lines through their centers. */
const LEAD = 40;
const AGENT = 30;
/** Between the people's columns; a column's width when they scroll sideways (more than two). */
const COLUMN_GAP = 14;
const SCROLL_COLUMN = 168;
const PAGE = 16;
/** The line from an agent's trunk to its face. */
const ELBOW = 18;
/** Faces on a channel's card before "+N". */
const CHANNEL_FACES = 4;

/**
 * Equipe on the phone (ADR 0148), one page with each thing said once: the org chart (the right hand on top, each
 * person with the agents that report to them, joined by lines), the channels as places with who works in each, who is
 * in none, and the setores with their lead and substitute. With no setores, what they give and, for who can, the first
 * one. Editing setores, the map's drag and Governança e uso are on the web.
 */
export function TeamScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const team = useTeam(orgId);
  const groups = useAgentGroups(orgId);
  const channels = useChannels(orgId);
  const members = useMembers(orgId);
  const pull = usePullRefresh(() =>
    Promise.allSettled([team.refetch(), groups.refetch(), channels.refetch(), members.refetch()]),
  );
  const lodi = rightHandOf(dir.agents);
  const agents = (team.data?.agents ?? []).filter((a) => a.id !== lodi?.id);
  const people = new Set((members.data ?? []).map((m) => m.userId));
  const chart = chartByPerson(agents, groups.data ?? [], people);
  const places = mapColumns(
    agents,
    (channels.data ?? []).map((c) => c.id),
  );
  const rooms = places.filter((p) => p.channelId !== null);
  const outside = places.find((p) => p.channelId === null)?.agents ?? [];
  const sectors = teamSections("list", {
    agents,
    groups: groups.data ?? [],
    members: members.data ?? [],
    channels: channels.data ?? [],
    rightHandId: lodi?.id ?? null,
  }).filter((s) => s.group);
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const arranges = can(org, "manage_agents");
  const noSectors = noSectorsCopy(arranges);
  const summary = [
    t("team.agents", { count: agents.length }),
    t("team.people", { count: chart.filter((c) => c.personId).length }),
    rooms.length > 0 ? t("filters.channels", { count: rooms.length }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PushedLargeTitle
      title={t("team.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <Text variant="subhead" tone="muted" style={styles.summary}>
        {summary}
      </Text>

      <SectionHeader title={t("team.view.chart")} />
      <OrgChart lodi={lodi ? { id: lodi.id, name: lodi.name } : null} columns={chart} />

      {rooms.length > 0 || outside.length > 0 ? (
        <>
          <SectionHeader title={t("team.sectors.channels")} count={rooms.length} />
          <View style={styles.grid}>
            {rooms.map((r) => (
              <ChannelCard
                key={r.channelId}
                channelId={r.channelId ?? ""}
                name={channelName(r.channelId ?? "")}
                agents={r.agents}
              />
            ))}
          </View>
          {outside.length > 0 ? (
            <View style={styles.outside}>
              <View style={styles.faces}>
                {outside.slice(0, CHANNEL_FACES).map((a, i) => (
                  <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
                    <AgentFace agentId={a.id} size={24} live={false} />
                  </View>
                ))}
              </View>
              <Text variant="small" tone="muted" numberOfLines={1} style={styles.grow}>
                {`${t("team.list.noChannel")}: ${outside.map((a) => a.name).join(", ")}`}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      <SectionHeader title={t("team.view.sectors")} {...(sectors.length > 0 ? { count: sectors.length } : {})} />
      {sectors.length === 0 ? (
        <EmptyState
          size="panel"
          agent={lodi ? agentLook(lodi) : true}
          title={t(noSectors.title)}
          subtitle={t(noSectors.text)}
          {...(arranges
            ? {
                action: (
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    label={t("agentGroups.create")}
                    onPress={() => router.push("/sector-new")}
                  />
                ),
              }
            : {})}
        />
      ) : (
        sectors.map((s, i) => (
          <ListRow
            key={s.key}
            divider={i > 0}
            leading={<Tile icon="members" size={44} />}
            title={s.title ?? ""}
            sub={[
              `${t("team.sectors.leadLabel")}: ${s.lead ?? t("team.sectors.nobody")}`,
              `${t("team.sectors.backupLabel")}: ${s.backup ?? t("team.sectors.nobody")}`,
            ].join(" · ")}
            subLines={1}
            time={t("team.agents", { count: s.agents.length })}
          />
        ))
      )}
    </PushedLargeTitle>
  );
}

/**
 * The org chart as a tree: the right hand, a stem down to a bar across the people, and each person's agents hanging
 * from a line under them. Every line passes through the faces' centers. More than two people scroll sideways.
 */
function OrgChart({
  lodi,
  columns,
}: {
  lodi: { id: string; name: string } | null;
  columns: { personId: string | null; agents: TeamAgent[] }[];
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const { width } = useWindowDimensions();
  const wide = columns.length > 2;
  const column = wide ? SCROLL_COLUMN : Math.floor((width - PAGE * 2 - COLUMN_GAP) / 2);
  const line = { backgroundColor: c.line2 };
  const bar = (columns.length - 1) * (column + COLUMN_GAP);
  return (
    <View>
      {lodi ? (
        <View style={styles.page}>
          <Pressable
            onPress={() => router.push(`/agent/${lodi.id}`)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.lead, pressed && styles.pressed]}
          >
            <AgentFace agentId={lodi.id} size={LEAD} live={false} />
            <View style={styles.grow}>
              <Text variant="title" numberOfLines={1}>
                {lodi.name}
              </Text>
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {t("team.map.lodi")}
              </Text>
            </View>
          </Pressable>
          {columns.length > 0 ? <View style={[styles.stem, line]} /> : null}
        </View>
      ) : null}
      <ScrollView
        horizontal
        scrollEnabled={wide}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.columns}
      >
        {lodi && columns.length > 1 ? <View style={[styles.bar, line, { width: bar + 1 }]} /> : null}
        {columns.map((col) => (
          <View key={col.personId ?? "none"} style={[styles.column, { width: column }]}>
            {lodi ? <View style={[styles.drop, line]} /> : null}
            <View style={styles.person}>
              {col.personId ? (
                <Face who={{ type: "person", id: col.personId }} size={LEAD} />
              ) : (
                <Tile icon="person" size={LEAD} />
              )}
              <View style={styles.grow}>
                <Text variant="subhead" style={styles.semibold} numberOfLines={1}>
                  {col.personId ? dir.nameOf({ type: "person", id: col.personId }) : t("team.noOwner")}
                </Text>
                <Text variant="caption" tone="faint" numberOfLines={1}>
                  {t("team.agents", { count: col.agents.length })}
                </Text>
              </View>
            </View>
            <View style={styles.branch}>
              {col.agents.map((a, i) => (
                <Pressable
                  key={a.id}
                  onPress={() => router.push(`/agent/${a.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={[a.name, a.role].filter(Boolean).join(", ")}
                  style={({ pressed }) => [styles.node, pressed && styles.pressed]}
                >
                  <View style={[styles.trunk, line, i === col.agents.length - 1 ? styles.trunkEnd : null]} />
                  <View style={[styles.elbow, line]} />
                  <AgentFace agentId={a.id} size={AGENT} mode={a.busy ? "run" : "idle"} live={false} />
                  <View style={styles.grow}>
                    <Text variant="subhead" style={styles.semibold} numberOfLines={1}>
                      {a.name}
                    </Text>
                    {a.role.trim() ? (
                      <Text variant="caption" tone="muted" numberOfLines={1}>
                        {a.role.trim()}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/** A channel as a place (an object, so a card): its name, the faces of the agents in it and who they are. */
function ChannelCard({ channelId, name, agents }: { channelId: string; name: string; agents: TeamAgent[] }) {
  const c = useColors();
  const surface = useSurface();
  const { width } = useWindowDimensions();
  const more = agents.length - CHANNEL_FACES;
  return (
    <Pressable
      onPress={() => router.push(chatHref(channelId))}
      accessibilityRole="button"
      accessibilityLabel={`#${name}, ${agents.map((a) => a.name).join(", ")}`}
      style={({ pressed }) => [
        styles.card,
        surface,
        { width: Math.floor((width - PAGE * 2 - 10) / 2) },
        pressed && styles.pressed,
      ]}
    >
      <Text variant="subhead" style={styles.semibold} numberOfLines={1}>
        {`#${name}`}
      </Text>
      <View style={styles.faces}>
        {agents.slice(0, CHANNEL_FACES).map((a, i) => (
          <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
            <AgentFace agentId={a.id} size={AGENT} mode={a.busy ? "run" : "idle"} live={false} ring={c.raised} />
          </View>
        ))}
        {more > 0 ? (
          <Text variant="caption" tone="faint" style={styles.more}>
            {`+${more}`}
          </Text>
        ) : null}
      </View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {agents.map((a) => a.name).join(", ")}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Under the large title's words (20 in, not the page's 16), tucked to it as Memória's and Wiki's lines are.
  summary: { paddingHorizontal: 20, marginTop: -4 },
  page: { paddingHorizontal: PAGE },
  lead: { flexDirection: "row", alignItems: "center", gap: 10 },
  // From the right hand's face center down to the people's bar.
  stem: { width: 1, height: 14, marginLeft: LEAD / 2 - 0.5 },
  columns: { paddingHorizontal: PAGE, gap: COLUMN_GAP },
  // Across the people's face centers, at the top of their drops.
  bar: { position: "absolute", top: 0, left: PAGE + LEAD / 2 - 0.5, height: 1 },
  column: { paddingTop: 14 },
  drop: { position: "absolute", top: 0, left: LEAD / 2 - 0.5, width: 1, height: 14 },
  person: { flexDirection: "row", alignItems: "center", gap: 10 },
  // The agents hang from a line under the person's face center.
  branch: { marginLeft: LEAD / 2 - 0.5 },
  // Past the elbow and 8 more: the agent's face hangs off its line.
  node: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 46, paddingLeft: ELBOW + 8 },
  trunk: { position: "absolute", left: 0, top: 0, bottom: 0, width: 1 },
  trunkEnd: { bottom: "50%" },
  elbow: { position: "absolute", left: 0, top: "50%", width: ELBOW, height: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: PAGE },
  card: { padding: 12, gap: 8, borderRadius: 20, borderBottomLeftRadius: 6 },
  faces: { flexDirection: "row", alignItems: "center" },
  overlap: { marginLeft: -8 },
  more: { marginLeft: 6 },
  outside: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PAGE, paddingTop: 14 },
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  pressed: { opacity: 0.7 },
});
