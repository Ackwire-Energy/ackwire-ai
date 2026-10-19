import type { Issue, IssueColumn } from "@agenteschat/client";
import { toolActivity } from "@agenteschat/client/lib/activity";
import { dueLabel } from "@agenteschat/client/lib/format";
import { toolLabel } from "@agenteschat/client/lib/work";
import { router } from "expo-router";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, Count, Icon, type IconName, LIST_AVATAR, PixelOrbit, Text } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { criteriaProgress, currentStep, type IssueState, isLate, issueState, latestPr } from "./logic";

/** An agent's step in the person's words ("Consultou o github · trips.service.ts"), as the web says it. */
export function useStepText() {
  const { t } = useTranslation();
  return useCallback(
    (step: { tool: string; detail?: string } | null | undefined) => {
      if (!step) return "";
      const a = toolActivity(step.tool, null, step.detail ?? null);
      const label = t(`chat.work.step.${a.kind}`, {
        app: a.app ?? "",
        tool: toolLabel(step.tool),
        defaultValue: toolLabel(step.tool),
      });
      return step.detail ? `${label} · ${step.detail}` : label;
    },
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
  waiting: "shield",
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

/** Criteria checked of all, in Doto: "2/4". */
export function CriteriaCount({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const p = criteriaProgress(issue);
  if (!p) return null;
  return (
    <View
      style={styles.inline}
      accessible
      accessibilityLabel={t("issues.criteriaLabel", { done: p.done, total: p.total })}
    >
      <Icon name="checkc" size={12} color={c.faint} />
      <Count value={p.done} size={13} color={c.faint} />
      <Text variant="caption" tone="faint">
        /
      </Text>
      <Count value={p.total} size={13} color={c.faint} />
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

/**
 * One task in the list (MobileDriveIssues.html `.irow`): who has it, "#134 · Alta · até sex", the title in
 * two lines, then its state, the agent's current step while it works, and the criteria.
 */
export const IssueRow = memo(function IssueRow({
  issue: i,
  divider,
  live,
}: {
  issue: Issue;
  divider: boolean;
  live: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const stepText = useStepText();
  const step = issueState(i) === "running" ? stepText(currentStep(i.work)) : "";
  const late = isLate(i);
  return (
    <Pressable
      onPress={() => router.push(`/issues/${i.number}`)}
      accessibilityRole="button"
      accessibilityLabel={t("issues.open", { number: i.number, title: i.title })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line }]} /> : null}
      <View style={styles.lead}>
        <AssigneeFace issue={i} size={46} live={live} />
      </View>
      <View style={styles.text}>
        <View style={styles.inline}>
          <Text variant="caption" tone="muted">
            #{i.number}
          </Text>
          <PriorityMark issue={i} />
          {i.dueDate && i.status !== "done" && i.status !== "canceled" ? (
            <Text variant="caption" style={{ color: late ? c.warn : c.faint }}>
              · {t("mobile.issues.until", { date: dueLabel(t, i18n.language, i.dueDate) })}
            </Text>
          ) : null}
        </View>
        <Text variant="body" numberOfLines={2} style={styles.title}>
          {i.title}
        </Text>
        <View style={styles.meta}>
          <StateChip issue={i} />
          {step ? (
            <Text variant="small" tone="muted" numberOfLines={1} style={styles.step}>
              {step}
            </Text>
          ) : null}
          <CriteriaCount issue={i} />
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 76,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 16,
  },
  divider: { position: "absolute", top: 0, right: 0, left: 14 + LIST_AVATAR + 12, height: StyleSheet.hairlineWidth },
  lead: { width: LIST_AVATAR, height: LIST_AVATAR, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  inline: { flexDirection: "row", alignItems: "center", gap: 4 },
  bold: { fontWeight: "600" },
  title: { fontWeight: "600" },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, minWidth: 0 },
  step: { flexShrink: 1 },
  column: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    paddingBottom: 4,
    paddingHorizontal: 20,
  },
  columnName: { fontWeight: "600", flexShrink: 1 },
});
