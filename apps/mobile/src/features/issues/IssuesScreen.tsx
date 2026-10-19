import { type Issue, useIssueColumns, useIssues } from "@agenteschat/client";
import { router } from "expo-router";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, RefreshControl, StyleSheet, View } from "react-native";
import { Button, EmptyState, Filters, IconButton, SectionHeader, Text } from "@/ui";
import { WaitingStrip } from "../chats/WaitingStrip";
import type { WaitingItem } from "../chats/waiting";
import { useColors, useMeId, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { filterCounts, ISSUE_FILTERS, type IssueFilter, issueSections, waitsOnYou } from "./logic";
import { ColumnHeader, IssueRow, useColumnLabel } from "./parts";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/** What waits on you in tasks, as the strip's items (it opens the issue). */
function waitingFromIssues(list: Issue[]): WaitingItem[] {
  return list.filter(waitsOnYou).map((i) => ({
    key: `i:${i.id}`,
    kind: i.work?.state === "waiting_approval" ? "approval" : "question",
    agentId: i.work?.agentId ?? (i.assignee?.type === "agent" ? i.assignee.id : null),
    title: `#${i.number} ${i.title}`,
    createdAt: i.work?.since ?? null,
    expiresAt: null,
    weight: 1,
    href: `/issues/${i.number}`,
    threadId: null,
    missionId: null,
  }));
}

/**
 * Issues (MobileDriveIssues.html, "Lista"), pushed from Você: the filters (Abertas and Com você with their
 * counts, Dos agentes, Concluídas), what waits on you as the dark strip, then the sections by stage
 * (Em andamento, Em revisão, A fazer), each with its board columns named where the board is customized.
 * "+" opens "Nova tarefa". Columns are edited on the web only.
 */
export function IssuesScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const issues = useIssues(orgId);
  const columns = useIssueColumns(orgId);
  const columnLabel = useColumnLabel();
  const pull = usePullRefresh(issues.refetch);
  const [filter, setFilter] = useState<IssueFilter>("open");
  const [stripOpen, setStripOpen] = useState(false);
  const all = issues.data ?? [];
  const counts = filterCounts(all, meId);
  const sections = useMemo(
    () => issueSections(issues.data ?? [], filter, meId, columns.data ?? []),
    [issues.data, filter, meId, columns.data],
  );
  const waiting = useMemo(() => waitingFromIssues(issues.data ?? []), [issues.data]);
  const openNew = () => router.push("/issues/new");
  let row = 0;
  return (
    <PushedLargeTitle
      title={t("mobile.issues.title")}
      right={<IconButton icon="plus" label={t("mobile.issues.new")} onPress={openNew} />}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      onScrollBeginDrag={() => setStripOpen(false)}
    >
      <Filters
        items={ISSUE_FILTERS.map((f) => ({
          key: f,
          label: t(`mobile.issues.filter.${f}`),
          ...(f === "open" || f === "mine" ? { count: counts[f] } : {}),
        }))}
        value={filter}
        onChange={(k) => setFilter(k as IssueFilter)}
      />
      {filter !== "done" && waiting.length > 0 ? (
        <View style={styles.strip}>
          <WaitingStrip items={waiting} open={stripOpen} onOpenChange={setStripOpen} />
        </View>
      ) : null}
      {issues.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      ) : issues.isError && !issues.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.issues.loadFailed")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void issues.refetch()}
          />
        </View>
      ) : sections.length === 0 ? (
        <EmptyState
          title={t("mobile.issues.empty")}
          {...(filter === "open" && all.length === 0 ? { subtitle: t("mobile.issues.emptyOpen") } : {})}
          action={
            filter === "open" ? (
              <Button variant="primary" size="sm" icon="plus" label={t("mobile.issues.new")} onPress={openNew} />
            ) : undefined
          }
        />
      ) : (
        sections.map((s) => (
          <Fragment key={s.key}>
            <SectionHeader title={t(`mobile.issues.section.${s.key}`)} count={s.count} />
            {s.groups.map((g) => (
              <Fragment key={g.key}>
                {s.showColumns && g.column ? (
                  <ColumnHeader label={columnLabel(g.column)} count={g.items.length} />
                ) : null}
                {g.items.map((i, k) => {
                  row += 1;
                  return <IssueRow key={i.id} issue={i} divider={k > 0} live={row <= LIVE_ROWS} />;
                })}
              </Fragment>
            ))}
          </Fragment>
        ))
      )}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  strip: { paddingTop: 8 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
});
