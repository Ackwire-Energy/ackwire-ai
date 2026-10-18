import { useWorkingRuns } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { AgentAvatar, Card, Count, EmptyState, Icon, LargeTitleScreen, PixelOrbit, Section, Sky, Text } from "@/ui";
import { useOpenDm } from "../new/useOpenDm";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile, useSurface } from "../shared/parts";
import { useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { busyAgents, workByAgent } from "./logic";
import { workTitle } from "./work";

/** Working agents named in the "Trabalhando agora" card (the crew above shows them all, up to this too). */
const WORKING_LINES = 4;

/**
 * Agentes (MobileConversas.html): who is working now on top (the crew over the sky and what each one is
 * on), then the whole team in two columns, Trabalhando (orbit) or Livre. Tapping an agent opens the
 * direct conversation with it (its profile is in that conversation's bar); "Novo agente" at the end.
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const surface = useSurface();
  const header = useTabHeader();
  const openDm = useOpenDm();
  const runs = useWorkingRuns(useOrgId());
  const work = useWorkingNow();
  const busy = busyAgents(work);
  const agents = [...dir.agents].sort((a, b) => a.name.localeCompare(b.name));
  const working = workByAgent(work).filter((w) => dir.agentById.has(w.agentId));
  const pull = usePullRefresh(runs.refetch);
  const open = (a: (typeof agents)[number]) => {
    if (a.canTalk === false) router.push(`/agent/${a.id}`);
    else void openDm({ agentId: a.id });
  };
  return (
    <LargeTitleScreen
      title={t("mobile.agents.title")}
      subtitle={t("mobile.agents.subtitle", { count: agents.length, working: busy.size })}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {working.length > 0 ? (
        <View style={[styles.now, surface]}>
          <View style={styles.band}>
            <Sky
              color={agentLook(dir.agentById.get(working[0]?.agentId ?? "")).color}
              depth={0.8}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.k}>
              <PixelOrbit color={agentLook(dir.agentById.get(working[0]?.agentId ?? "")).color} size={11} />
              <Text variant="footnote" tone="muted" style={styles.bold}>
                {t("mobile.home.workingNow")}
              </Text>
              <Count value={working.length} size={15} />
            </View>
            <View style={styles.crew}>
              {working.slice(0, WORKING_LINES).map((w) => (
                <AgentFace key={w.key} agentId={w.agentId} size={44} mode="run" />
              ))}
            </View>
          </View>
          <View style={styles.lines}>
            {working.slice(0, WORKING_LINES).map((w) => (
              <Pressable
                key={w.key}
                onPress={() => {
                  const a = dir.agentById.get(w.agentId);
                  if (a) open(a);
                }}
                accessibilityRole="button"
                style={styles.line}
              >
                <AgentFace agentId={w.agentId} size={22} mode="run" live={false} />
                <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
                  <Text variant="small" tone="ink" style={styles.bold}>
                    {dir.agentById.get(w.agentId)?.name ?? ""}
                  </Text>
                  {` ${workTitle(t, w)}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {dir.loading ? null : agents.length === 0 ? <EmptyState title={t("mobile.agents.empty")} sky /> : null}
      <Section title={t("mobile.agents.all")} count={agents.length}>
        <View style={styles.grid}>
          {agents.map((a, i) => {
            const on = busy.has(a.id);
            const look = agentLook(a);
            return (
              <Pressable
                key={a.id}
                onPress={() => open(a)}
                accessibilityRole="button"
                accessibilityLabel={on ? t("mobile.agents.workingLabel", { name: a.name }) : a.name}
                style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
              >
                <Card>
                  <View style={styles.agc}>
                    <AgentAvatar agent={look} size={50} mode={on ? "run" : "idle"} live={i < 8} />
                    <Text variant="callout" style={styles.name} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Text variant="small" tone="muted" numberOfLines={1}>
                      {a.role || " "}
                    </Text>
                    <View style={styles.st}>
                      {on ? (
                        <PixelOrbit color={look.color} size={11} />
                      ) : (
                        <Icon name="checkc" size={14} color={c.faint} />
                      )}
                      <Text variant="footnote" tone="faint">
                        {on ? t("mobile.agents.working") : t("mobile.agents.free")}
                      </Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => router.push("/new-agent")}
            accessibilityRole="button"
            style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
          >
            <View style={[styles.newCard, { borderColor: c.line2 }]}>
              <Tile icon="plus" size={44} />
              <Text variant="small" tone="muted" style={styles.bold}>
                {t("mobile.agents.new")}
              </Text>
            </View>
          </Pressable>
        </View>
      </Section>
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  now: { marginHorizontal: 16, marginTop: 6, borderRadius: 26, overflow: "hidden", paddingBottom: 14 },
  band: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  k: { flexDirection: "row", alignItems: "center", gap: 6 },
  crew: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-end",
    gap: 28,
    marginTop: 8,
    minHeight: 52,
  },
  lines: { paddingHorizontal: 16, marginTop: 12, gap: 6 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cell: { width: "48.5%" },
  pressed: { transform: [{ scale: 0.97 }] },
  agc: { padding: 14, gap: 1 },
  name: { fontWeight: "600", marginTop: 10 },
  bold: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
  st: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  newCard: {
    minHeight: 152,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
});
