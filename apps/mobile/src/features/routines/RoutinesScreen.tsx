import { type Routine, useRoutines } from "@agenteschat/client";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  Icon,
  IconButton,
  SearchField,
  SectionHeader,
  Segmented,
  Text,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { mayCreate } from "../new/logic";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { SheetHostProvider } from "../shared/SheetHost";
import { useWhenText } from "./hooks";
import { isAtWork, routineAgents, routineSections, STATUS_FILTERS, type StatusFilter } from "./logic";
import { RoutineRow } from "./parts";
import { RoutineHorizon } from "./RoutineHorizon";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;
/** While a run works (or waits), the list is asked again this often: its state and its strip move on. */
const WORKING_POLL_MS = 15_000;

/**
 * Rotinas, pushed from Você (the web's page on the phone): what the agents do on their own, "Nova rotina" as the
 * bar's "+" (as Tarefas; with none yet, the empty state's own button), the next hours as a horizon, then the
 * search, the status (Todas, Ativas, Pausadas, Por evento, with counts) and the agent; "No ar" and "Pausadas" in
 * the server's order, the one-offs that already ran folded under "Concluídos". A row opens its routine; "…" (or a
 * long press) its actions.
 */
export function RoutinesScreen() {
  return (
    <SheetHostProvider>
      <RoutineList />
    </SheetHostProvider>
  );
}

function RoutineList() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const meId = useMeId();
  const routines = useRoutines(orgId);
  const pull = usePullRefresh(routines.refetch);
  const now = useNow(60_000);
  const whenText = useWhenText();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [picked, setAgentId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const list = useMemo(() => routines.data ?? [], [routines.data]);
  const agents = useMemo(() => routineAgents(list), [list]);
  // The agent filter holds only while its row shows and has that agent: one gone (its routines deleted, or one
  // agent left) never keeps the list filtered with no way to see why.
  const agentId = picked && agents.length > 1 && agents.includes(picked) ? picked : null;
  const sections = useMemo(
    () => routineSections(list, { status, agentId, query: q }, whenText),
    [list, status, agentId, q, whenText],
  );
  const working = list.some(isAtWork);
  const { refetch } = routines;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refetch(), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [working, refetch]);
  const openNew = () => router.push("/routines/new");
  const clear = () => {
    setQ("");
    setStatus("all");
    setAgentId(null);
  };
  const ownsAgent = Boolean(meId) && dir.agents.some((a) => a.ownerUserId === meId);
  const mayNew = mayCreate(useOrg().org, "routine", { ownsAgent });
  // A routine paused, resumed, deleted or filtered out while the person watches fades, and the rest slide into place.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  let row = 0;
  const rows = (items: Routine[]) =>
    items.map((r, i) => {
      row += 1;
      return (
        <Animated.View key={r.id} {...fade} layout={layout}>
          <RoutineRow routine={r} now={now} divider={i > 0} live={row <= LIVE_ROWS} />
        </Animated.View>
      );
    });
  return (
    <PushedLargeTitle
      title={t("routines.title")}
      {...(mayNew ? { right: <IconButton icon="plus" label={t("routines.new")} onPress={openNew} /> } : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.head}>
        <Text variant="subhead" tone="muted">
          {t("routines.subtitle")}
        </Text>
      </View>
      {routines.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      ) : routines.isError && !routines.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.routines.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void refetch()} />
        </View>
      ) : list.length === 0 ? (
        <FirstUse place="routines" acts={mayNew} label={t("routines.new")} onPress={openNew} />
      ) : (
        // Loaded, the list fades in over the spinner; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <RoutineHorizon routines={list} now={now} />
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("routines.search")}
                accessibilityLabel={t("routines.search")}
                returnKeyType="search"
              />
            </View>
            {/* Four choices with their counts can be wider than a small phone: they scroll sideways there. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.status}
            >
              <Segmented
                items={STATUS_FILTERS.map((s) => ({
                  key: s,
                  label: t(`routines.status.${s}`),
                  count: sections.counts[s],
                }))}
                value={status}
                onChange={(k) => setStatus(k as StatusFilter)}
              />
            </ScrollView>
            {agents.length > 1 ? (
              <Filters
                items={[
                  { key: "", label: t("mobile.routines.anyAgent") },
                  ...agents.map((id) => ({ key: id, label: dir.nameOf({ type: "agent", id }) })),
                ]}
                value={agentId ?? ""}
                onChange={(k) => setAgentId(k || null)}
              />
            ) : null}
            {/* No count on these headers: the status choices above already say how many are live and paused. */}
            {sections.live.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={status === "paused" ? t("routines.groupPaused") : t("routines.groupLive")} />
                {rows(sections.live)}
              </Animated.View>
            ) : null}
            {sections.paused.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("routines.groupPaused")} />
                {rows(sections.paused)}
              </Animated.View>
            ) : null}
            {sections.live.length === 0 && sections.paused.length === 0 && sections.filtered ? (
              <Animated.View {...fade} layout={layout}>
                <EmptyState
                  size="inline"
                  title={t("routines.noResults")}
                  action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={clear} />}
                />
              </Animated.View>
            ) : null}
            {sections.done.length > 0 && status === "all" ? (
              <Animated.View {...fade} layout={layout}>
                <Pressable
                  onPress={() => setShowDone((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showDone }}
                  hitSlop={4}
                  style={({ pressed }) => [styles.doneToggle, pressed && styles.pressed]}
                >
                  <Icon name={showDone ? "chev" : "right"} size={15} color={c.muted} />
                  <Text variant="small" tone="muted" style={styles.bold}>
                    {t("routines.doneToggle", { count: sections.done.length })}
                  </Text>
                </Pressable>
                {showDone ? rows(sections.done) : null}
              </Animated.View>
            ) : null}
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 20, paddingBottom: 12, gap: 14 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  search: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  status: { paddingHorizontal: 16, paddingBottom: 8 },
  doneToggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20, paddingVertical: 14 },
  pressed: { opacity: 0.6 },
  bold: { fontWeight: "600" },
});
