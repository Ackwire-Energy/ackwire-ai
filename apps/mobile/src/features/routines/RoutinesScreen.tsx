import { type Routine, useRoutines } from "@agenteschat/client";
import { routineStateTime, routineStateWords } from "@agenteschat/client/lib/routine-view";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  GroupedList,
  GroupedRow,
  MEDIA_ROW,
  MediaRow,
  SCREEN_X,
  SearchField,
  SkeletonList,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { CollapsibleSection } from "../chats/HomeSection";
import { routineHref, widgetHref } from "../links/logic";
import { mayCreate } from "../new/logic";
import { AgentFace } from "../shared/Face";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useDirectory, useMeId, useNamesComputers, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useNextText, useSay, useWhenText } from "./hooks";
import {
  type AgentGroup,
  byAgent,
  isAtWork,
  isDoneOnce,
  isPaused,
  isRunning,
  routineSections,
  routineTitle,
  STATUS_FILTERS,
  type StatusFilter,
  whenIcon,
} from "./logic";
import { RoutineHorizon } from "./RoutineHorizon";

/** While a run works (or waits), the list is asked again this often: its state and its next run move on. */
const WORKING_POLL_MS = 15_000;
/** Sections whose agent's face moves (a long list stays light). */
const LIVE_SECTIONS = 6;

/** Where a routine opens: its screen, or a widget's routine its widget (ADR 0135: it is changed there). */
const openRoutine = (r: Routine) =>
  router.push(r.target.type === "widget" ? widgetHref(r.target.widgetId, r.target.dashboardId) : routineHref(r.id));

/**
 * Rotinas, pushed from Você (the web's page on the phone), as Drive: the large title, "Nova rotina" as the bar's "+"
 * (with none yet, the empty state's own button), the search, one row of filters (Todas, Ativas, Pausadas, Por evento),
 * the next hours as the web's horizon (one lane per agent), then the routines broken by agent as the web reads them:
 * one section per agent, its face, its name and how many it has as the head, its routines under it in a grouped card
 * (the live ones first, then the paused ones, faint). A row says what starts it (its tile), its name, when it runs and
 * what's next; what needs a look takes the "when" line in the waiting color. The one-offs that already ran fold under
 * "Concluídos", broken by agent too. A row opens its routine, where its actions are.
 */
export function RoutinesScreen() {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const meId = useMeId();
  const routines = useRoutines(orgId);
  const pull = usePullRefresh(routines.refetch);
  const now = useNow(60_000);
  const whenText = useWhenText();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [showDone, setShowDone] = useState(false);
  const list = useMemo(() => routines.data ?? [], [routines.data]);
  const sections = useMemo(
    () => routineSections(list, { status, agentId: null, query: q }, whenText),
    [list, status, q, whenText],
  );
  const nameOf = useCallback((agentId: string) => dir.nameOf({ type: "agent", id: agentId }), [dir]);
  const groups = useMemo(
    () => byAgent([...sections.live, ...sections.paused], nameOf, i18n.language),
    [sections.live, sections.paused, nameOf, i18n.language],
  );
  const doneGroups = useMemo(
    () => byAgent(sections.done, nameOf, i18n.language),
    [sections.done, nameOf, i18n.language],
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
  };
  const ownsAgent = Boolean(meId) && dir.agents.some((a) => a.ownerUserId === meId);
  const mayNew = mayCreate(useOrg().org, "routine", { ownsAgent });
  // A section that comes or goes with a filter, or as a routine is paused or deleted, fades while the rest slide into
  // place; what shows when the screen opens doesn't fade section by section (as Drive's days).
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  return (
    <PushedLargeTitle
      title={t("routines.title")}
      grouped
      {...(mayNew ? { actions: [{ icon: "plus", sf: "plus", label: t("routines.new"), onPress: openNew }] } : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {routines.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : routines.isError && !routines.data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : list.length === 0 ? (
        <FirstUse place="routines" acts={mayNew} label={t("routines.new")} onPress={openNew} />
      ) : (
        // Loaded, the list fades in over the skeleton; the sections it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("routines.search")}
                accessibilityLabel={t("routines.search")}
                returnKeyType="search"
              />
            </View>
            {/* One row of filters, words only: each agent's head says how many. */}
            <Filters
              items={STATUS_FILTERS.map((s) => ({ key: s, label: t(`routines.status.${s}`) }))}
              value={status}
              onChange={(k) => setStatus(k as StatusFilter)}
            />
            <View style={styles.in}>
              <RoutineHorizon routines={list} now={now} open={openRoutine} />
              {groups.map((g, i) => (
                <Animated.View key={g.agentId} {...fade} layout={layout}>
                  <AgentSection group={g} now={now} live={i < LIVE_SECTIONS} />
                </Animated.View>
              ))}
              {groups.length === 0 && sections.filtered ? (
                <Animated.View {...fade} layout={layout}>
                  <EmptyState
                    size="inline"
                    title={t("routines.noResults")}
                    action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={clear} />}
                  />
                </Animated.View>
              ) : null}
              {doneGroups.length > 0 && status === "all" ? (
                <Animated.View {...fade} layout={layout}>
                  <CollapsibleSection
                    title={t("routines.done")}
                    count={sections.done.length}
                    collapsed={!showDone}
                    onToggle={() => setShowDone((v) => !v)}
                  >
                    {doneGroups.map((g) => (
                      <AgentSection key={g.agentId} group={g} now={now} live={false} />
                    ))}
                  </CollapsibleSection>
                </Animated.View>
              ) : null}
            </View>
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/**
 * One agent's routines: its face and name as the section's head with how many it has here (the web's horizon label),
 * then its routines in a grouped card. A row is the system's grouped row: the tile of what starts it, the routine's
 * name, when it runs (or, in the waiting color, what needs a look) and what's next; a paused or finished one is faint.
 * `now` ticks each minute ("Próxima em 10 min" stays true).
 */
function AgentSection({ group, now, live }: { group: AgentGroup<Routine>; now: number; live: boolean }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const say = useSay();
  const names = useNamesComputers();
  const whenText = useWhenText();
  const nextText = useNextText();
  const at = new Date(now);
  const name = dir.nameOf({ type: "agent", id: group.agentId }) || t("channel.unknownAgent");
  const count = t("routines.horizon.agentRoutines", { count: group.routines.length });
  const running = group.routines.some(isRunning);
  return (
    <>
      <View style={styles.head} accessible accessibilityRole="header" accessibilityLabel={`${name}, ${count}`}>
        <MediaRow
          size="row"
          face={
            <AgentFace agentId={group.agentId} size={MEDIA_ROW.row.face} live={live} mode={running ? "run" : "idle"} />
          }
          name={name}
          meta={count}
        />
      </View>
      <GroupedList>
        {group.routines.map((r) => {
          const done = isDoneOnce(r);
          const state = routineStateWords(r, routineStateTime(t, i18n.language, r), names);
          // Something needs a look (a reason it paused, failures, waiting for a computer or a person): it says so in
          // place of when it runs.
          const needsLook = !done && state.tone === "waiting";
          const next = nextText(r, at);
          return (
            <GroupedRow
              key={r.id}
              icon={needsLook ? "wait" : whenIcon(r)}
              label={routineTitle(r)}
              labelLines={2}
              faint={isPaused(r) || done}
              sub={needsLook ? say(state) : whenText(r)}
              subLines={2}
              {...(needsLook ? { subTone: "amber" as const } : {})}
              {...(next && !needsLook ? { belowText: next } : {})}
              chevron
              onPress={() => openRoutine(r)}
            />
          );
        })}
      </GroupedList>
    </>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 10 },
  // The horizon, the agents' cards and the fold sit in the grouped list's column.
  in: { paddingHorizontal: SCREEN_X, paddingTop: 8 },
  // A grouped list's header room: 20 above, 8 under, the card's 16 in from its side.
  head: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 16 },
});
