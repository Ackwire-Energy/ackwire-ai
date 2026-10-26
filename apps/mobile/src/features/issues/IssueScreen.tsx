import {
  type Actor,
  type Issue,
  type IssueColumn,
  type IssuePriority,
  type IssueStatus,
  keys,
  useAiStatus,
  useApi,
  useChannels,
  useIssue,
  useIssueAction,
  useIssueColumns,
} from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isOpen, PRIORITIES, STATUSES } from "@agenteschat/client/lib/issues";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Chip, Icon, IconButton, type IconName, PixelOrbit, Text, useToast } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { MessageText } from "../chat/MessageText";
import { chatHref } from "../links/logic";
import { useOpenDm } from "../new/useOpenDm";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import {
  type ActionItem,
  ActionList,
  FocusLive,
  PushedHeader,
  successHaptic,
  tapHaptic,
  useSurface,
} from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import {
  columnChoices,
  columnOfIssue,
  conversationOf,
  criteriaProgress,
  issueState,
  minutesSince,
  stageCustomized,
} from "./logic";
import { StateChip, useColumnLabel, useStepText } from "./parts";

/**
 * One task (called "tarefa" in the app): where it came from, the big title, its state, priority
 * and who has it; the agent's card with its live steps; the description, the acceptance criteria (checked
 * here too), what is linked (the source message, Drive files, PRs) and its sub-issues. Conversar and Concluir
 * at the bottom; "…" moves it to another board column, changes priority and who does it, as the web allows.
 */
export function IssueScreen({ number }: { number: number }) {
  return (
    <SheetHostProvider>
      <IssueView number={number} />
    </SheetHostProvider>
  );
}

function IssueView({ number }: { number: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const insets = useSafeAreaInsets();
  const issue = useIssue(orgId, number);
  const pull = usePullRefresh(issue.refetch);
  const sheet = useSheet();
  const i = issue.data;
  if (!i) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title={`#${number}`} solid={false} />
        <View style={styles.center}>
          {issue.isError ? (
            <Text tone="muted" style={styles.centerText}>
              {t("issues.notFound")}
            </Text>
          ) : (
            <ActivityIndicator color={c.muted} />
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={`#${i.number}`}
        solid={false}
        right={
          <IconButton icon="more" label={t("mobile.issues.more")} onPress={() => sheet.open(<IssueMenu issue={i} />)} />
        }
      />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={{ paddingBottom: insets.bottom + BAR_HEIGHT + 24 }}
        >
          <Head issue={i} />
          <WorkCard issue={i} />
          <Description issue={i} />
          <Criteria issue={i} />
          <Linked issue={i} />
          <SubIssues issue={i} />
        </ScrollView>
      </FocusLive>
      <BottomBar issue={i} />
    </View>
  );
}

const BAR_HEIGHT = 68;

/** "#134 · criada pelo Atlas a partir do Sentry · #tech", the title, the chips. */
function Head({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const channel = i.channelId ? channels.data?.find((x) => x.id === i.channelId) : undefined;
  const from =
    i.source.type === "message"
      ? t("mobile.issues.fromMessage")
      : i.source.type === "forum"
        ? t("mobile.issues.fromForum")
        : i.source.type === "agent"
          ? t("mobile.issues.fromAgent")
          : i.source.type === "webhook"
            ? t("mobile.issues.fromWebhook", { provider: i.source.provider })
            : null;
  const creator = dir.nameOf(i.createdBy);
  const line = [
    `#${i.number}`,
    [creator ? t("mobile.issues.createdBy", { name: creator }) : null, from].filter(Boolean).join(" "),
    channel ? `#${channel.name}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const assignee = i.assignee;
  return (
    <View style={styles.head}>
      <Text variant="small" tone="faint">
        {line}
      </Text>
      <Text variant="display2" accessibilityRole="header" style={styles.bigTitle} maxFontSizeMultiplier={1.4}>
        {i.title}
      </Text>
      <View style={styles.chips}>
        <StateChip issue={i} />
        {i.priority === "high" ? <Chip icon="flag" label={t("issues.priority.high")} /> : null}
        {assignee ? (
          <Chip label={dir.nameOf(assignee)} leading={<Face who={assignee} size={14} live={false} />} />
        ) : (
          <Chip icon="circle" label={t("issues.noAssignee")} />
        )}
      </View>
    </View>
  );
}

/** The agent's work: its live steps (an orbit on the current one), what it waits for, or that it stopped. */
function WorkCard({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const now = useNow(30_000);
  const stepText = useStepText();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const ai = useAiStatus(orgId);
  const w = i.work;
  if (!w || i.assignee?.type !== "agent" || !isOpen(i)) return null;
  // Stopped because the agent has nothing to think with: say so, and the way out is connecting one.
  const noAi = aiStateOf(ai.data, w.agentId) === "no_ai";
  const agent = dir.agentById.get(i.assignee.id);
  const name = agent?.name ?? "";
  const color = agentLook(agent).color;
  const state = issueState(i);
  const mins = minutesSince(w.since, now);
  const sub =
    state === "stalled"
      ? t("mobile.issues.stalledSince", { when: relativeTime(t, i18n.language, w.since) })
      : state === "waiting"
        ? t("mobile.issues.waitsYou")
        : mins < 1
          ? t("mobile.issues.justStarted")
          : t("mobile.issues.workingFor", { count: mins });
  const last = w.steps.length - 1;
  return (
    <View style={[styles.work, surface]}>
      <View style={styles.workHead}>
        <Face who={i.assignee} size={24} mode={state === "running" ? "run" : state === "stalled" ? "rest" : "idle"} />
        <Text variant="body" style={styles.bold}>
          {name}
        </Text>
        <Text variant="body" tone="muted" style={styles.grow} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      {state === "stalled" ? (
        <>
          {w.steps[last] ? (
            <Text variant="small" tone="muted">
              {t("issues.work.lastStep", { step: stepText(w.steps[last]) })}
            </Text>
          ) : null}
          {noAi ? (
            <Text variant="small" tone="muted">
              {t("noAi.agent", { name })}
            </Text>
          ) : w.reason ? (
            <Text variant="small" tone="muted">
              {t(`issues.work.reason.${w.reason}`)}
            </Text>
          ) : null}
          <View>
            {noAi ? (
              <Button
                variant="primary"
                size="sm"
                icon="brain"
                label={t("mobile.ai.connect")}
                onPress={() => openConnectAi()}
              />
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon="right"
                label={t("issues.work.continue")}
                disabled={action.isPending}
                onPress={() =>
                  action.mutate(
                    { type: "ask", id: i.id, agentId: w.agentId },
                    {
                      onSuccess: () =>
                        toast({ title: t("issues.work.resumed", agentGrammar(t, name)), agentId: w.agentId }),
                      onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                    },
                  )
                }
              />
            )}
          </View>
        </>
      ) : w.steps.length > 0 ? (
        <View style={styles.steps}>
          {w.steps.map((s, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps only append; two may share a time and tool
            <View key={`${s.at}-${s.tool}-${k}`} style={styles.stepRow}>
              {k === last && state === "running" ? (
                <PixelOrbit color={color} size={12} />
              ) : (
                <Icon name="checkc" size={13} color={c.faint} />
              )}
              <Text variant="small" tone={k === last ? "ink2" : "muted"} style={styles.grow}>
                {stepText(s)}
                {k === last && state === "running" ? "…" : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : state === "running" ? (
        <Text variant="small" tone="muted">
          {t("issues.work.starting")}
        </Text>
      ) : null}
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <Text variant="footnote" tone="faint" accessibilityRole="header" style={styles.groupTitle}>
        {title.toLocaleUpperCase()}
      </Text>
      {children}
    </View>
  );
}

function Description({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  return (
    <Group title={t("issues.description")}>
      <View style={styles.desc}>
        {i.description.trim() ? (
          <MessageText body={i.description} />
        ) : (
          <Text variant="body" tone="faint">
            {t("issues.noDescription")}
          </Text>
        )}
      </View>
    </Group>
  );
}

/** "Critérios de aceite · 0 de 3": a check box per criterion (anyone who can see the issue may check). */
function Criteria({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  // The tap shows at once; the issue comes back from the server with it.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  if (i.criteria.length === 0) return null;
  const criteria = i.criteria.map((x) => ({ ...x, done: pending[x.id] ?? x.done }));
  const p = criteriaProgress({ criteria });
  return (
    <Group
      title={`${t("issues.criteria")} · ${t("mobile.issues.criteriaOf", { done: p?.done ?? 0, total: p?.total ?? 0 })}`}
    >
      <View style={[styles.card, surface]}>
        {criteria.map((x, k) => (
          <Pressable
            key={x.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: x.done }}
            accessibilityLabel={x.text}
            onPress={() => {
              tapHaptic();
              const done = !x.done;
              setPending((s) => ({ ...s, [x.id]: done }));
              action.mutate(
                { type: "criterion", id: i.id, criterionId: x.id, done },
                {
                  onSettled: () =>
                    setPending((s) => {
                      const { [x.id]: _, ...rest } = s;
                      return rest;
                    }),
                  onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                },
              );
            }}
            style={({ pressed }) => [styles.crit, pressed && { backgroundColor: c.sunken }]}
          >
            {k > 0 ? <View style={[styles.critLine, { backgroundColor: c.line }]} /> : null}
            <View
              style={[styles.box, x.done ? { backgroundColor: c.ink } : { borderWidth: 1.5, borderColor: c.line2 }]}
            >
              {x.done ? <Icon name="check" size={13} color={c.bg} /> : null}
            </View>
            <Text variant="body" tone={x.done ? "faint" : "ink"} style={[styles.grow, x.done && styles.struck]}>
              {x.text}
            </Text>
            {x.done && x.doneBy?.type === "agent" ? <Face who={x.doneBy} size={18} live={false} /> : null}
          </Pressable>
        ))}
      </View>
    </Group>
  );
}

function LinkRow({
  icon,
  label,
  onPress,
  first,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  first: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      style={({ pressed }) => [styles.link, pressed && { backgroundColor: c.sunken }]}
    >
      {!first ? <View style={[styles.critLine, { backgroundColor: c.line }]} /> : null}
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name={icon} size={16} color={c.muted} />
      </View>
      <Text variant="body" numberOfLines={1} style={styles.grow}>
        {label}
      </Text>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** Ligados: the message it came from, the Drive files, the pull requests. */
function Linked({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const rows: { key: string; icon: IconName; label: string; onPress: () => void }[] = [];
  if (i.source.type === "message") {
    const { channelId } = i.source;
    const channel = channels.data?.find((x) => x.id === channelId);
    rows.push({
      key: "source",
      icon: "chat",
      label: channel ? t("mobile.issues.linkMessage", { channel: channel.name }) : t("mobile.issues.linkMessagePlain"),
      onPress: () => router.push(chatHref(channelId)),
    });
  }
  for (const a of i.artifacts)
    rows.push({
      key: `a:${a.id}`,
      icon: "doc",
      label: a.title,
      onPress: () => router.push({ pathname: "/file/[id]", params: { id: a.id } }),
    });
  for (const pr of i.pullRequests)
    rows.push({
      key: `pr:${pr.number}`,
      icon: "code",
      label: t("issues.pr", { number: pr.number }),
      onPress: () => void Linking.openURL(pr.url).catch(() => undefined),
    });
  if (rows.length === 0) return null;
  return (
    <Group title={t("issues.links")}>
      <View style={[styles.card, surface]}>
        {rows.map((r, k) => (
          <LinkRow key={r.key} icon={r.icon} label={r.label} onPress={r.onPress} first={k === 0} />
        ))}
      </View>
    </Group>
  );
}

function SubIssues({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const subs = i.subIssues ?? [];
  if (subs.length === 0) return null;
  return (
    <Group title={t("mobile.issues.subIssues")}>
      <View style={[styles.card, surface]}>
        {subs.map((s, k) => (
          <LinkRow
            key={s.id}
            icon={s.status === "done" ? "checkc" : "circle"}
            label={`#${s.number} ${s.title} · ${t(`issues.status.${s.status}`)}`}
            onPress={() => router.push(`/issues/${s.number}`)}
            first={k === 0}
          />
        ))}
      </View>
    </Group>
  );
}

/** Conversar (the issue's channel, or the agent's conversation) and Concluir / Reabrir. */
function BottomBar({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const openDm = useOpenDm();
  const target = conversationOf(i);
  const open = isOpen(i);
  const setStatus = (status: IssueStatus) =>
    action.mutate(
      { type: "update", id: i.id, patch: { status } },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: t(status === "done" ? "mobile.issues.finished" : "mobile.issues.reopened", { number: i.number }),
          });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  return (
    <View pointerEvents="box-none" style={[styles.bar, { paddingBottom: insets.bottom + 10 }]}>
      <LinearGradient
        pointerEvents="none"
        colors={[`${c.bg}00`, c.bg]}
        locations={[0, 0.3]}
        style={StyleSheet.absoluteFill}
      />
      {target ? (
        <View style={styles.grow}>
          <Button
            variant="secondary"
            wide
            icon="chat"
            label={t("mobile.issues.talk")}
            onPress={() => {
              if ("channelId" in target) router.push(chatHref(target.channelId));
              else void openDm({ agentId: target.agentId });
            }}
          />
        </View>
      ) : null}
      <View style={styles.grow}>
        <Button
          variant={open ? "primary" : "secondary"}
          wide
          icon={open ? "checkc" : "right"}
          label={t(open ? "mobile.issues.finish" : "mobile.issues.reopen")}
          disabled={action.isPending}
          onPress={() => setStatus(open ? "done" : "todo")}
        />
      </View>
    </View>
  );
}

/**
 * The column picker: the board's columns grouped by stage (the stage as the header; a column without a name
 * reads as its stage). A board that isn't customized shows just the stages. Choosing one sends `columnId`.
 */
function ColumnPicker({
  issue: i,
  columns,
  onPick,
}: {
  issue: Issue;
  columns: IssueColumn[];
  onPick: (c: IssueColumn) => void;
}) {
  const { t } = useTranslation();
  const columnLabel = useColumnLabel();
  const current = columnOfIssue(i, columns)?.id;
  const stages = columnChoices(columns);
  const item = (c: IssueColumn): ActionItem => ({
    key: c.id,
    label: columnLabel(c),
    ...(c.id === current ? { trailing: <Icon name="check" size={18} /> } : {}),
    onPress: () => onPick(c),
  });
  if (!stages.some((s) => stageCustomized(s.columns)))
    return <ActionList items={stages.flatMap((s) => s.columns.map(item))} />;
  return (
    <>
      {stages.map((s) => (
        <View key={s.stage} style={styles.pickerStage}>
          <Text variant="label" accessibilityRole="header" style={styles.pickerTitle}>
            {t(`mobile.issues.section.${s.stage}`)}
          </Text>
          <ActionList items={s.columns.map(item)} />
        </View>
      ))}
    </>
  );
}

/** "…": its column, priority, who does it (an agent is asked and starts), stop the agent, cancel. */
function IssueMenu({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const meId = useMeId();
  const action = useIssueAction(orgId);
  const columns = useIssueColumns(orgId);
  const columnLabel = useColumnLabel();
  const toast = useToast();
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(orgId, runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.issues(orgId) }),
  });
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const update = (patch: Parameters<typeof action.mutate>[0], done?: string) => {
    sheet.close();
    action.mutate(patch, {
      onSuccess: () => toast({ title: done ?? t("mobile.issues.changed") }),
      onError: failed,
    });
  };
  const assign = (who: Actor | null) => {
    if (who?.type === "agent") {
      sheet.close();
      action.mutate(
        { type: "ask", id: i.id, agentId: who.id },
        {
          onSuccess: () => toast({ title: t("mobile.issues.changed"), agentId: who.id }),
          // Couldn't ask (not in a shared channel…): it stays assigned to the agent, as on the web.
          onError: () => action.mutate({ type: "update", id: i.id, patch: { assignee: who } }, { onError: failed }),
        },
      );
    } else update({ type: "update", id: i.id, patch: { assignee: who } });
  };
  const same = (a: Actor | null, b: Actor | null) => (a?.type ?? null) === (b?.type ?? null) && a?.id === b?.id;
  const pick = (items: ActionItem[]) => sheet.open(<ActionList items={items} />);
  const statusItems = (): ActionItem[] =>
    STATUSES.map((s) => ({
      key: s,
      label: t(`issues.status.${s}`),
      ...(s === i.status ? { trailing: <Icon name="check" size={18} /> } : {}),
      onPress: () => update({ type: "update", id: i.id, patch: { status: s } }),
    }));
  const priorityItems = (): ActionItem[] =>
    PRIORITIES.map((p: IssuePriority) => ({
      key: p,
      label: t(`issues.priority.${p}`),
      ...(p === i.priority ? { trailing: <Icon name="check" size={18} /> } : {}),
      onPress: () => update({ type: "update", id: i.id, patch: { priority: p } }),
    }));
  const people: Actor[] = [
    ...dir.agents.filter((a) => a.canTalk !== false).map((a) => ({ type: "agent" as const, id: a.id })),
    ...(meId ? [{ type: "person" as const, id: meId }] : []),
  ];
  const assigneeItems = (): ActionItem[] => [
    ...people.map((who) => ({
      key: `${who.type}:${who.id}`,
      label: who.type === "person" && who.id === meId ? t("mobile.issues.you") : dir.nameOf(who),
      leading: <Face who={who} size={26} live={false} />,
      ...(same(who, i.assignee) ? { trailing: <Icon name="check" size={18} /> } : {}),
      onPress: () => assign(who),
    })),
    {
      key: "nobody",
      icon: "circle" as const,
      label: t("mobile.issues.nobody"),
      ...(i.assignee === null ? { trailing: <Icon name="check" size={18} /> } : {}),
      onPress: () => assign(null),
    },
  ];
  const board = columns.data ?? [];
  const column = columnOfIssue(i, board);
  // Columns not loaded (or failed): the stages, as before the board had columns.
  const openColumns = () =>
    board.length > 0
      ? sheet.open(
          <ColumnPicker
            issue={i}
            columns={board}
            onPick={(c) =>
              update(
                { type: "update", id: i.id, patch: { columnId: c.id } },
                t("mobile.issues.moved", { number: i.number, column: columnLabel(c) }),
              )
            }
          />,
        )
      : pick(statusItems());
  const w = i.work;
  const items: ActionItem[] = [
    {
      key: "column",
      icon: "circle",
      label: t("mobile.issues.actions.status"),
      hint: column ? columnLabel(column) : t(`issues.status.${i.status}`),
      onPress: openColumns,
    },
    {
      key: "priority",
      icon: "flag",
      label: t("mobile.issues.actions.priority"),
      hint: t(`issues.priority.${i.priority}`),
      onPress: () => pick(priorityItems()),
    },
    {
      key: "assignee",
      icon: "agent",
      label: t("mobile.issues.actions.assignee"),
      hint: i.assignee ? dir.nameOf(i.assignee) : t("mobile.issues.nobody"),
      onPress: () => pick(assigneeItems()),
    },
  ];
  if (w?.state === "running" && w.runId) {
    const runId = w.runId;
    items.push({
      key: "stop",
      icon: "pause",
      label: t("issues.work.stop"),
      onPress: () => {
        sheet.close();
        stop.mutate(runId, { onError: failed });
      },
    });
  }
  if (isOpen(i))
    items.push({
      key: "cancel",
      icon: "x",
      danger: true,
      label: t("mobile.issues.actions.cancel"),
      onPress: () =>
        update(
          { type: "update", id: i.id, patch: { status: "canceled" } },
          t("mobile.issues.actions.canceled", { number: i.number }),
        ),
    });
  return <ActionList items={items} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  centerText: { textAlign: "center" },
  head: { paddingHorizontal: 20, paddingTop: 6, gap: 6, marginBottom: 14 },
  bigTitle: { marginVertical: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  work: { marginHorizontal: 16, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  workHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  steps: { gap: 5 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  groupTitle: { paddingTop: 22, paddingBottom: 7, paddingHorizontal: 20, letterSpacing: 0.4 },
  desc: { paddingHorizontal: 20 },
  card: { marginHorizontal: 16, borderRadius: 14, overflow: "hidden" },
  crit: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  critLine: { position: "absolute", top: 0, left: 44, right: 0, height: StyleSheet.hairlineWidth },
  box: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", marginTop: 1 },
  struck: { textDecorationLine: "line-through" },
  link: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  pickerStage: { gap: 6 },
  pickerTitle: { paddingHorizontal: 4 },
  tile: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
});
