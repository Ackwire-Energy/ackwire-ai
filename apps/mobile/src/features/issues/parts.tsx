import type { Issue, IssueColumn } from "@agenteschat/client";
import { dueLabel } from "@agenteschat/client/lib/format";
import { stepPhrase } from "@agenteschat/client/lib/work";
import { AGENT_GRADIENTS, type AgentColorName } from "@agenteschat/ui/agent/engine";
import { router } from "expo-router";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, Icon, type IconName, PixelOrbit, Text } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile, useSurface } from "../shared/parts";
import { criteriaProgress, currentStep, type IssueState, isLate, issueState, latestPr, listState } from "./logic";

/** An agent's step in the person's words ("Mexeu nos arquivos do PC · trips.service.ts"), as the web says it. */
export function useStepText() {
  const { t } = useTranslation();
  return useCallback(
    (step: Parameters<typeof stepPhrase>[1] | null | undefined) => (step ? stepPhrase(t, step) : ""),
    [t],
  );
}

/** A column's name as people read it: its own, or the stage's when it has none ("A fazer"). */
export function useColumnLabel() {
  const { t } = useTranslation();
  return useCallback((c: Pick<IssueColumn, "name" | "stage">) => c.name ?? t(`issues.status.${c.stage}`), [t]);
}

/** A board column inside a stage of the list (only where the board is customized): its name and count. */
export function ColumnHeader({ label, count }: { label: string; count: number }) {
  return (
    <View style={styles.column} accessibilityRole="header">
      <Text variant="small" tone="muted" numberOfLines={1} style={styles.columnName}>
        {label}
      </Text>
      <Text variant="small" tone="faint">
        {count}
      </Text>
    </View>
  );
}

const STATE_ICON: Record<Exclude<IssueState, "running">, IconName> = {
  waiting: "wait",
  stalled: "pause",
  review: "code",
  progress: "clock",
  todo: "circle",
  done: "checkc",
  canceled: "x",
};

/** The issue's state as a chip: "Trabalhando" with the agent's orbit, "Em revisão · PR #212", "Esperando você"… */
export function StateChip({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const state = issueState(issue);
  const pr = latestPr(issue);
  const label =
    state === "review" && pr
      ? t("mobile.issues.state.reviewPr", { number: pr.number })
      : t(`mobile.issues.state.${state}`);
  if (state === "running") {
    const agent = issue.assignee?.type === "agent" ? dir.agentById.get(issue.assignee.id) : undefined;
    return <Chip label={label} leading={<PixelOrbit color={agentLook(agent).color} size={10} />} />;
  }
  return <Chip label={label} icon={STATE_ICON[state]} />;
}

/** "Alta" with the flag (only high priority stands out). */
export function PriorityMark({ issue }: { issue: Pick<Issue, "priority"> }) {
  const { t } = useTranslation();
  const c = useColors();
  if (issue.priority !== "high") return null;
  return (
    <View style={styles.inline}>
      <Icon name="flag" size={12} color={c.warn} />
      <Text variant="caption" style={[styles.bold, { color: c.warn }]}>
        {t("issues.priority.high")}
      </Text>
    </View>
  );
}

/** The criteria as a pixel track in the agent's colors, with "2/4": the one being worked on blinks. */
export function CriteriaTrack({ issue, color, going }: { issue: Issue; color: AgentColorName; going: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const p = criteriaProgress(issue);
  if (!p) return null;
  const [top, bottom] = AGENT_GRADIENTS[color];
  return (
    <View
      style={styles.track}
      accessible
      accessibilityLabel={t("issues.criteriaLabel", { done: p.done, total: p.total })}
    >
      <View style={styles.cells}>
        {Array.from({ length: p.total }, (_, k) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: the cells have no identity, only a position
            key={`cell-${k + 1}`}
            style={[
              styles.cell,
              {
                backgroundColor:
                  k < p.done ? (k === p.done - 1 ? top : bottom) : going && k === p.done ? `${top}66` : c.sunken,
              },
            ]}
          />
        ))}
      </View>
      <Text variant="caption" tone="faint">
        {p.done}/{p.total}
      </Text>
    </View>
  );
}

/** Who has it: the agent's living body (moving while it works) or the person's face; nobody: an empty tile. */
export function AssigneeFace({ issue, size, live }: { issue: Issue; size: number; live: boolean }) {
  if (!issue.assignee) return <Tile icon="circle" size={size} />;
  const running = issue.work?.state === "running";
  return (
    <Face
      who={issue.assignee}
      size={issue.assignee.type === "agent" ? size : size - 4}
      mode={running ? "run" : issue.work?.state === "stalled" ? "rest" : "idle"}
      live={live}
    />
  );
}

/** A row's state, only when the section doesn't say it already: icon and words, no pill, on the text's edge. */
function StateLine({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const state = listState(issue);
  if (!state) return null;
  const pr = latestPr(issue);
  const label =
    state === "review" && pr
      ? t("mobile.issues.state.reviewPr", { number: pr.number })
      : t(`mobile.issues.state.${state}`);
  const tone = state === "waiting" ? c.warn : c.muted;
  const agent = issue.assignee?.type === "agent" ? dir.agentById.get(issue.assignee.id) : undefined;
  return (
    <View style={styles.inline}>
      {state === "running" ? (
        <PixelOrbit color={agentLook(agent).color} size={10} />
      ) : (
        <Icon name={STATE_ICON[state]} size={12} color={tone} />
      )}
      <Text variant="caption" style={[styles.bold, { color: tone }]}>
        {label}
      </Text>
    </View>
  );
}

/**
 * One task on the board: why it stands out, the title, the agent's current step while it works, its criteria, then
 * the number, priority and date with who has it on the far side.
 */
export const BoardCard = memo(function BoardCard({ issue: i, live }: { issue: Issue; live: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const stepText = useStepText();
  const state = issueState(i);
  const agent = i.assignee?.type === "agent" ? dir.agentById.get(i.assignee.id) : undefined;
  const color = agentLook(agent).color;
  const step = state === "running" ? stepText(currentStep(i.work)) : "";
  const late = isLate(i);
  const due = i.dueDate && i.status !== "done" && i.status !== "canceled";
  return (
    <Pressable
      onPress={() => router.push(`/issues/${i.number}`)}
      accessibilityRole="button"
      accessibilityLabel={t("issues.open", { number: i.number, title: i.title })}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <StateLine issue={i} />
      <Text variant="callout" numberOfLines={3} style={styles.title}>
        {i.title}
      </Text>
      {state === "running" ? (
        <View style={styles.inline}>
          <PixelOrbit color={color} size={12} />
          <Text variant="small" tone="muted" numberOfLines={1} style={styles.step}>
            {step || t("mobile.issues.state.running")}
          </Text>
        </View>
      ) : null}
      <CriteriaTrack issue={i} color={color} going={state === "running"} />
      <View style={styles.meta}>
        <Text variant="caption" tone="faint">
          #{i.number}
        </Text>
        <PriorityMark issue={i} />
        {due ? (
          <Text variant="caption" style={{ color: late ? c.warn : c.faint }}>
            {t("mobile.issues.until", { date: dueLabel(t, i18n.language, i.dueDate as string) })}
          </Text>
        ) : null}
        <View style={styles.step} />
        <AssigneeFace issue={i} size={26} live={live} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: 16, paddingHorizontal: 13, paddingVertical: 12, gap: 8 },
  pressed: { opacity: 0.85 },
  inline: { flexDirection: "row", alignItems: "center", gap: 6 },
  bold: { fontWeight: "600" },
  title: { fontWeight: "600" },
  step: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "center", columnGap: 8 },
  track: { flexDirection: "row", alignItems: "center", gap: 8 },
  cells: { flex: 1, flexDirection: "row", gap: 3 },
  cell: { flex: 1, height: 7 },
  column: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    paddingBottom: 2,
    paddingHorizontal: 4,
  },
  columnName: { fontWeight: "600", flexShrink: 1 },
});
