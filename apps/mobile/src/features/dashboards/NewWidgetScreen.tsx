import {
  useCreateWidget,
  useDashboards,
  useHomeDashboard,
  useWidgetCost,
  useWidgetSuggestions,
  widgetCostLine,
  type WidgetFormat,
  type WidgetSchedule,
  type WidgetSuggestion,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { formatUsd } from "@agenteschat/client/lib/format";
import { WIDGET_FORMATS, type WidgetSize } from "@agenteschat/ui/widgets/spec";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
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
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { useAgentLook, useExampleWords } from "./hooks";
import { destinationsOf, HOME, previewKind, realBoardId, sizeFor, widgetPreview } from "./logic";
import { AgentPicker, ChoiceChips, KindGlyph, ScheduleChoice, SizeChoice } from "./parts";
import { BuildingSweep, WidgetCard } from "./WidgetView";

/** The longest ask and alert condition the server takes (ADR 0134). */
const PROMPT_MAX = 2000;
const CONDITION_MAX = 200;

/**
 * "New widget", pushed (never a sheet; ADR 0134): the widget on top as it will look (example data until the agent
 * builds it), what to follow with the agent's suggestions, who looks after it, the format, how often it updates,
 * whether to alert (and when), and where it goes; then what happens next and what it costs. "Create" in the bar.
 * `dashboardId`: the board it starts on (`home` for My Home).
 */
export function NewWidgetScreen({ dashboardId }: { dashboardId: string }) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const words = useExampleWords();
  const list = useDashboards(orgId);
  const create = useCreateWidget(orgId);
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
  // The first agent until the person picks one.
  useEffect(() => {
    const first = agents[0];
    if (!agentId && first) setAgentId(first.id);
  }, [agentId, agents]);
  const look = useAgentLook(agentId);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  const suggestions = useWidgetSuggestions(orgId, agentId);
  const sources = suggestions.data?.sources ?? [];
  const cost = useWidgetCost(orgId, agentId, schedule);
  const destinations = destinationsOf(list.data);
  // A board asked for is only known once the list is: never fall back to My Home before it is.
  const destination = destinations.find((d) => d.id === dest) ?? (list.data ? destinations[0] : undefined);
  const home = useHomeDashboard(orgId, destination?.id === HOME);
  const target = destination ? realBoardId(destination.id, home.data?.id) : null;
  const where = destination?.home ? t("dashboards.home") : (destination?.title ?? "");
  const preview = widgetPreview(text, format, picked?.kind ?? null, words, size);
  const sized = sizeFor(previewKind(format, picked?.kind ?? null), size);
  const ready = Boolean(text.trim() && agentId && target) && !create.isPending;

  const pickAgent = (id: string) => {
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
  const submit = () => {
    if (!ready || !agentId || !target) return;
    const prompt = text.trim();
    create.mutate(
      {
        dashboardId: target,
        agentId,
        prompt,
        format,
        schedule,
        alert: { enabled: alert, condition: alert ? condition.trim() : "" },
        size: sized,
        ...(picked && prompt === (picked.prompt || picked.title).trim() ? { title: picked.title } : {}),
      },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("dashboards.newWidget.created", { where }), agentId });
          // From the board it goes on: back to it, where the widget is being built; else to that board.
          if (destination && destination.id === dashboardId) goBack();
          else router.replace(boardHref(destination?.id));
        },
        onError: failed,
      },
    );
  };

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

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.newWidget.title")}
        solid={false}
        grouped
        action={{ label: t("mobile.dashboards.create"), disabled: !ready, onPress: submit }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 28 + insets.bottom }]}
      >
        <View style={styles.preview}>
          {preview && agentId ? (
            <View style={preview.w === 1 ? styles.previewHalf : styles.previewFull}>
              <WidgetCard
                big
                widget={{
                  title: preview.title,
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
          ) : (
            <View style={[styles.ghost, { borderColor: c.line2 }]}>
              <BuildingSweep
                color={look.color}
                text={t("dashboards.newWidget.emptyPreview", { name: look.name })}
                height={44}
              />
            </View>
          )}
          {preview ? (
            <Text variant="caption" tone="faint">
              {`${t("widgets.preview.label")} · ${t("widgets.preview.example")}`}
            </Text>
          ) : null}
        </View>

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

        <GroupedHeader>{t("dashboards.newWidget.who")}</GroupedHeader>
        <View style={styles.bleed}>
          <AgentPicker agents={agents} value={agentId} onChange={pickAgent} />
        </View>
        {agent && sources.length > 0 ? (
          <GroupedFooter>
            {t("dashboards.newWidget.reads", { role: agent.role || agent.name, sources: sources.join(", ") })}
          </GroupedFooter>
        ) : agents.length === 0 && !dir.loading ? (
          <GroupedFooter>{t("dashboards.newWidget.noAgents")}</GroupedFooter>
        ) : null}

        <GroupedHeader>{t("dashboards.newWidget.format")}</GroupedHeader>
        <View style={styles.bleed}>
          <ChoiceChips
            items={WIDGET_FORMATS.map((f) => ({
              key: f,
              label: t(`widgets.kinds.${f}`),
              icon: (color: string) => <KindGlyph kind={f} size={15} color={color} />,
            }))}
            value={format}
            onChange={setFormat}
          />
        </View>
        {format === "auto" ? (
          <GroupedFooter>{t("dashboards.newWidget.autoHint", { name: look.name })}</GroupedFooter>
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
  preview: { alignItems: "center", gap: 6, paddingTop: 8 },
  previewFull: { width: "100%" },
  previewHalf: { width: "60%" },
  ghost: {
    width: "100%",
    borderWidth: 1.5,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    padding: 14,
  },
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
  bleed: { marginHorizontal: -16 },
  gap: { height: 18 },
  condition: { paddingHorizontal: 14, paddingBottom: 12 },
  steps: { gap: 6, paddingHorizontal: 16, paddingTop: 14 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
});
