import {
  useConfirmWidget,
  useDashboards,
  useHomeDashboard,
  useRemoveWidget,
  useTestWidget,
  useWidgetCost,
  useWidgetDraft,
  useWidgetSuggestions,
  type Widget,
  widgetCostLine,
  type WidgetFormat,
  type WidgetSchedule,
  type WidgetSuggestion,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { formatUsd } from "@agenteschat/client/lib/format";
import { sizeToLayout, WIDGET_FORMATS, WIDGET_LIMITS, type WidgetSize } from "@agenteschat/ui/widgets/spec";
import { router } from "expo-router";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { boardHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { useAgentLook, useExampleWords, useWidgetWords } from "./hooks";
import {
  confirmTitle,
  destinationsOf,
  HOME,
  newWidgetAction,
  previewKind,
  realBoardId,
  shownWidgetTitle,
  sizeFor,
  testKeyOf,
  testPhase,
  widgetPreview,
} from "./logic";
import { type PickItem, usePickMenu } from "./menu";
import { KindGlyph, ScheduleChoice, SizeChoice } from "./parts";
import { BuildingSweep, WidgetCard } from "./WidgetView";

/** The longest ask and alert condition the server takes (ADR 0134). */
const PROMPT_MAX = 2000;
const CONDITION_MAX = 200;

/**
 * "New widget", pushed (never a sheet; ADR 0134): the widget on top (example data until it is tested), what to follow
 * with the agent's suggestions, who looks after it and the format (rows that open a pick menu), how often it updates,
 * whether to alert (and when), and where it goes; then what happens next and what it costs. "Test" in the bar builds a
 * draft with real data, shown live on top; once it worked, its title can be changed and "Create" confirms it. Changing
 * the ask, the agent or the format after a test asks for a new one; testing again or leaving deletes the draft.
 * `dashboardId`: the board it starts on (`home` for My Home).
 */
export function NewWidgetScreen({ dashboardId }: { dashboardId: string }) {
  return (
    <SheetHostProvider>
      <NewWidget dashboardId={dashboardId} />
    </SheetHostProvider>
  );
}

function NewWidget({ dashboardId }: { dashboardId: string }) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const words = useExampleWords();
  const widgetWords = useWidgetWords();
  const pick = usePickMenu();
  const list = useDashboards(orgId);
  const test = useTestWidget(orgId);
  const confirm = useConfirmWidget(orgId);
  const remove = useRemoveWidget(orgId);
  const agents = useMemo(() => dir.agents.filter((a) => canTalk(a)), [dir.agents]);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<WidgetSuggestion | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [format, setFormat] = useState<WidgetFormat>("auto");
  // Null until the person picks one: the size follows the kind (S for a number or a goal, M otherwise).
  const [size, setSize] = useState<WidgetSize | null>(null);
  const [schedule, setSchedule] = useState<WidgetSchedule>("hour");
  const [alert, setAlert] = useState(true);
  const [condition, setCondition] = useState("");
  const [dest, setDest] = useState(dashboardId);
  const [pickDest, setPickDest] = useState(false);
  // The test: the draft it made (as it came back, until its live view loads), and what it was asked with.
  const [tested, setTested] = useState<{ widget: Widget; key: string } | null>(null);
  // The person's title for the tested draft; null keeps the agent's.
  const [title, setTitle] = useState<string | null>(null);
  // The first agent until the person picks one.
  useEffect(() => {
    const first = agents[0];
    if (!agentId && first) setAgentId(first.id);
  }, [agentId, agents]);

  // A draft nobody confirmed goes away with the screen (the server also sweeps old ones).
  const removeDraft = useRef(remove.mutate);
  useLayoutEffect(() => {
    removeDraft.current = remove.mutate;
  });
  const live = useRef({ draftId: null as string | null, confirmed: false, gone: false });
  useEffect(() => {
    live.current.gone = false;
    return () => {
      live.current.gone = true;
      const id = live.current.draftId;
      if (id && !live.current.confirmed) {
        live.current.draftId = null;
        removeDraft.current(id);
      }
    };
  }, []);

  const look = useAgentLook(agentId);
  const suggestions = useWidgetSuggestions(orgId, agentId);
  const sources = suggestions.data?.sources ?? [];
  const cost = useWidgetCost(orgId, agentId, schedule);
  const destinations = destinationsOf(list.data);
  // A board asked for is only known once the list is: never fall back to My Home before it is.
  const destination = destinations.find((d) => d.id === dest) ?? (list.data ? destinations[0] : undefined);
  const home = useHomeDashboard(orgId, destination?.id === HOME);
  const target = destination ? realBoardId(destination.id, home.data?.id) : null;
  const where = destination?.home ? t("dashboards.home") : (destination?.title ?? "");

  const draftQ = useWidgetDraft(orgId, tested?.widget.id ?? null);
  // A draft that is gone (swept, or removed elsewhere) is no test any more.
  const draft: Widget | null = tested && !draftQ.isError ? (draftQ.data ?? tested.widget) : null;
  const currentKey = testKeyOf(text, agentId, format);
  const phase = testPhase({ pending: test.isPending, draft, testedKey: tested?.key ?? null, currentKey });
  const action = newWidgetAction(phase);
  // Once tested, the size follows what the agent built (unless one was picked).
  const kind = phase === "ok" && draft?.kind ? draft.kind : previewKind(format, picked?.kind ?? null);
  const sized = sizeFor(kind, size);
  const preview = widgetPreview(text, format, picked?.kind ?? null, words, size);
  const asked = Boolean(text.trim() && agentId && target);
  const busy = test.isPending || confirm.isPending;
  const ready = asked && !busy && phase !== "testing";

  const pickAgent = (id: string) => {
    if (id === agentId) return;
    setAgentId(id);
    setPicked(null);
  };
  const suggest = (s: WidgetSuggestion) => {
    setText(s.prompt || s.title);
    setPicked(s);
    setFormat("auto");
    if (s.alert) {
      setAlert(true);
      setCondition(s.alert);
    }
  };
  const type = (next: string) => {
    setText(next);
    if (picked && next !== (picked.prompt || picked.title)) setPicked(null);
  };
  const alertInput = { enabled: alert, condition: alert ? condition.trim() : "" };

  /** Test (and Test again, Try again): the previous draft goes, a new one is built with real data. */
  const runTest = () => {
    if (!asked || !agentId || !target || busy) return;
    const previous = live.current.draftId;
    if (previous) removeDraft.current(previous);
    live.current.draftId = null;
    setTested(null);
    setTitle(null);
    const key = currentKey;
    test
      .mutateAsync({
        dashboardId: target,
        agentId,
        prompt: text.trim(),
        format,
        schedule,
        alert: alertInput,
        size: sized,
      })
      .then((widget) => {
        // Left while it was starting: nobody will confirm it.
        if (live.current.gone) {
          removeDraft.current(widget.id);
          return;
        }
        live.current.draftId = widget.id;
        setTested({ widget, key });
      })
      .catch((error: unknown) => {
        if (!live.current.gone) failed(error);
      });
  };

  /** Create: the tested draft goes on the board with the size, schedule, alert and title picked now. */
  const create = () => {
    if (phase !== "ok" || !draft || !target || busy) return;
    const name = confirmTitle(title, draft.title);
    live.current.confirmed = true;
    confirm.mutate(
      {
        widgetId: draft.id,
        dashboardId: target,
        size: sized,
        schedule,
        alert: alertInput,
        ...(name ? { title: name } : {}),
      },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("dashboards.newWidget.created", { where }), agentId: draft.agentId });
          // From the board it goes on: back to it; else to that board.
          if (destination && destination.id === dashboardId) goBack();
          else router.replace(boardHref(destination?.id));
        },
        onError: (error) => {
          live.current.confirmed = false;
          failed(error);
        },
      },
    );
  };

  const openAgents = () =>
    pick(
      t("dashboards.newWidget.who"),
      agents.map(
        (a): PickItem<string> => ({
          key: a.id,
          label: a.name,
          hint: a.role || null,
          // The face's top on the name's line, as beside every name in the app.
          leading: (
            <View style={styles.faceTop}>
              <AgentFace agentId={a.id} size={28} live={false} />
            </View>
          ),
        }),
      ),
      agentId,
      pickAgent,
    );
  const openFormats = () =>
    pick(
      t("dashboards.newWidget.format"),
      WIDGET_FORMATS.map(
        (f): PickItem<WidgetFormat> => ({
          key: f,
          label: t(`widgets.kinds.${f}`),
          hint: f === "auto" ? t("mobile.dashboards.formatAuto", { name: look.name }) : null,
          leading: <KindGlyph kind={f} size={20} color={c.muted} />,
        }),
      ),
      format,
      setFormat,
    );

  const costLine = widgetCostLine(schedule, cost.data);
  const costText =
    costLine.kind === "day" || costLine.kind === "week"
      ? t(`widgets.cost.${costLine.kind}`, { amount: formatUsd(i18n.language, costLine.usd), name: look.name })
      : t(`widgets.cost.${costLine.kind}`, { name: look.name });
  const readsStep = sources.length > 0 ? t("dashboards.newWidget.steps.reads", { sources: sources.join(", ") }) : null;
  const routineStep =
    schedule === "manual"
      ? t("dashboards.newWidget.steps.noRoutine")
      : t("dashboards.newWidget.steps.routineHint", { schedule: t(`widgets.schedules.${schedule}`) });
  const alertStep = alert
    ? t("dashboards.newWidget.steps.alert", { condition: condition.trim() || t("widgets.alert.placeholder") })
    : t("dashboards.newWidget.steps.noAlertHint");
  const steps: ({ icon: IconName; text: string } | null)[] = [
    { icon: "bolt", text: t("dashboards.newWidget.steps.builds", { name: look.name }) },
    readsStep ? { icon: "server", text: readsStep } : null,
    { icon: "clock", text: routineStep },
    { icon: "bell", text: alertStep },
    { icon: "chart", text: costText },
  ];

  const say = (key: string) => t(key);
  // "Real data · just now · This test cost $0.01".
  const testedCaption = (w: Widget) => {
    const real = t("dashboards.newWidget.tested", { when: w.refreshedAt ? widgetWords.ago(w.refreshedAt) : "" });
    if (w.lastCostUsd == null) return real;
    return `${real} · ${t("dashboards.newWidget.testCost", { cost: formatUsd(i18n.language, w.lastCostUsd) })}`;
  };
  const exampleCaption = [
    t("widgets.preview.label"),
    t("widgets.preview.example"),
    t("dashboards.newWidget.testFirst"),
  ].join(" · ");
  const layout = sizeToLayout(sized);

  let top: ReactNode;
  if (phase === "testing") {
    // Building with real data: a neutral title (the agent names it when it is done), never the ask.
    top = (
      <View style={[styles.ghost, { borderColor: c.line2 }]}>
        <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.semibold}>
          {shownWidgetTitle(draft?.title, draft?.kind ?? format, say)}
        </Text>
        <BuildingSweep
          color={look.color}
          text={t("dashboards.newWidget.testing", { name: look.name })}
          height={44}
        />
      </View>
    );
  } else if (phase === "failed" && draft) {
    top = (
      <View style={[styles.ghost, styles.failedBox, { borderColor: c.line2 }]}>
        <View style={styles.failedLine}>
          <Icon name="info" size={16} color={c.warn} />
          <Text variant="footnote" style={[styles.grow, { color: c.warn }]}>
            {t("dashboards.newWidget.testFailed", { reason: widgetWords.failure(draft) })}
          </Text>
        </View>
        <Button size="sm" variant="secondary" label={t("dashboards.newWidget.tryAgain")} onPress={runTest} />
      </View>
    );
  } else if (phase === "ok" && draft) {
    top = (
      <>
        <View style={layout.w === 1 ? styles.previewHalf : styles.previewFull}>
          <WidgetCard
            big
            widget={{
              title: title?.trim() || draft.title,
              kind: draft.kind,
              spec: draft.spec,
              status: draft.status,
              agentId: draft.agentId,
              refreshedAt: draft.refreshedAt,
              schedule,
              w: layout.w,
              h: layout.h,
            }}
            footer={null}
          />
        </View>
        <Text variant="caption" tone="faint" style={styles.center}>
          {testedCaption(draft)}
        </Text>
        <Button
          size="sm"
          variant="secondary"
          icon="play"
          label={t("dashboards.newWidget.testAgain")}
          onPress={runTest}
        />
      </>
    );
  } else if (preview && agentId) {
    top = (
      <>
        <View style={preview.w === 1 ? styles.previewHalf : styles.previewFull}>
          <WidgetCard
            big
            widget={{
              title: picked?.title ?? "",
              kind: preview.kind,
              spec: preview.spec,
              status: "ok",
              agentId,
              refreshedAt: null,
              schedule,
              w: preview.w,
              h: preview.h,
            }}
            footer={null}
          />
        </View>
        {phase === "stale" ? (
          <Text variant="caption" style={[styles.center, { color: c.warn }]}>
            {t("dashboards.newWidget.stale")}
          </Text>
        ) : (
          <Text variant="caption" tone="faint" style={styles.center}>
            {exampleCaption}
          </Text>
        )}
      </>
    );
  } else {
    top = (
      <View style={[styles.ghost, { borderColor: c.line2 }]}>
        <BuildingSweep
          color={look.color}
          text={t("dashboards.newWidget.emptyPreview", { name: look.name })}
          height={44}
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.newWidget.title")}
        solid={false}
        grouped
        action={
          action === "create"
            ? { label: t("mobile.dashboards.create"), disabled: busy || !target, onPress: create }
            : { label: t("dashboards.newWidget.test"), disabled: !ready, onPress: runTest }
        }
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 28 + insets.bottom }]}
      >
        <View style={styles.preview}>{top}</View>

        {phase === "ok" && draft ? (
          <>
            <GroupedHeader>{t("mobile.dashboards.widget.title")}</GroupedHeader>
            <TextArea
              value={title ?? draft.title}
              onChangeText={setTitle}
              placeholder={t("mobile.dashboards.widget.titlePlaceholder")}
              accessibilityLabel={t("mobile.dashboards.widget.title")}
              multiline={false}
              minHeight={46}
              maxLength={WIDGET_LIMITS.title}
              returnKeyType="done"
            />
          </>
        ) : null}

        <GroupedHeader>{t("dashboards.newWidget.what")}</GroupedHeader>
        <TextArea
          value={text}
          onChangeText={type}
          placeholder={t("dashboards.newWidget.whatPlaceholder")}
          accessibilityLabel={t("dashboards.newWidget.what")}
          maxLength={PROMPT_MAX}
          minHeight={72}
        />
        {(suggestions.data?.suggestions ?? []).length > 0 ? (
          <View style={styles.suggestions}>
            {(suggestions.data?.suggestions ?? []).map((s) => {
              const on = picked?.title === s.title;
              return (
                <Pressable
                  key={s.title}
                  onPress={() => suggest(s)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.suggestion, { backgroundColor: on ? c.ink : c.chip }]}
                >
                  <KindGlyph kind={s.kind} size={14} color={on ? c.bg : c.muted} />
                  <Text variant="subhead" numberOfLines={1} style={[styles.semibold, { color: on ? c.bg : c.ink2 }]}>
                    {s.title}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={styles.gap} />
        <GroupedList>
          <GroupedRow
            label={t("dashboards.newWidget.who")}
            value={look.name}
            valueLeading={agentId ? <AgentFace agentId={agentId} size={22} live={false} /> : null}
            chevron
            disabled={agents.length === 0}
            onPress={openAgents}
          />
          <GroupedRow
            label={t("dashboards.newWidget.format")}
            value={t(`widgets.kinds.${format}`)}
            valueLeading={<KindGlyph kind={format} size={16} color={c.faint} />}
            chevron
            onPress={openFormats}
          />
        </GroupedList>
        {agents.length === 0 && !dir.loading ? (
          <GroupedFooter>{t("dashboards.newWidget.noAgents")}</GroupedFooter>
        ) : null}

        <GroupedHeader>{t("widgets.sizes.label")}</GroupedHeader>
        <SizeChoice value={sized} onChange={setSize} />

        <GroupedHeader>{t("dashboards.newWidget.updates")}</GroupedHeader>
        <View style={styles.bleed}>
          <ScheduleChoice value={schedule} onChange={setSchedule} />
        </View>

        <View style={styles.gap} />
        <GroupedList>
          <GroupedRow
            icon="bell"
            label={t("widgets.alert.label")}
            labelLines={2}
            sub={alert ? t("widgets.alert.hint") : t("widgets.alert.none")}
            subLines={2}
            toggle={alert}
            onPress={() => setAlert((v) => !v)}
          />
          {alert ? (
            <View style={styles.condition}>
              <TextArea
                value={condition}
                onChangeText={setCondition}
                placeholder={t("widgets.alert.placeholder")}
                accessibilityLabel={t("widgets.alert.condition")}
                multiline={false}
                minHeight={46}
                maxLength={CONDITION_MAX}
                returnKeyType="done"
              />
            </View>
          ) : null}
          <GroupedRow
            icon="chart"
            label={t("dashboards.newWidget.destination")}
            value={where}
            chevron
            onPress={() => setPickDest((v) => !v)}
          />
          {pickDest
            ? destinations.map((d) => (
                <GroupedRow
                  key={d.id}
                  label={d.home ? t("dashboards.home") : (d.title ?? "")}
                  checked={d.id === destination?.id}
                  onPress={() => {
                    setDest(d.id);
                    setPickDest(false);
                  }}
                />
              ))
            : null}
        </GroupedList>

        <View style={styles.steps}>
          {steps.map((step) =>
            step ? (
              <View key={step.icon} style={styles.step}>
                <Icon name={step.icon} size={14} color={c.faint} />
                <Text variant="footnote" tone="faint" style={styles.grow}>
                  {step.text}
                </Text>
              </View>
            ) : null,
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  preview: { alignItems: "center", gap: 8, paddingTop: 8 },
  previewFull: { width: "100%" },
  previewHalf: { width: "60%" },
  ghost: {
    width: "100%",
    gap: 8,
    borderWidth: 1.5,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    padding: 14,
  },
  failedBox: { alignItems: "flex-start" },
  failedLine: { flexDirection: "row", alignItems: "flex-start", gap: 8, alignSelf: "stretch" },
  center: { textAlign: "center" },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 8 },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    maxWidth: "100%",
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  semibold: { fontWeight: "600", flexShrink: 1 },
  faceTop: { alignSelf: "flex-start" },
  bleed: { marginHorizontal: -16 },
  gap: { height: 18 },
  condition: { paddingHorizontal: 14, paddingBottom: 12 },
  steps: { gap: 6, paddingHorizontal: 16, paddingTop: 14 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
});
