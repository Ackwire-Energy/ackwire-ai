import {
  type UsageQueueClosedRow,
  type UsageQueueRow,
  useApi,
  useCancelUsageQueue,
  useUsageQueue,
} from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { closedNoteText } from "@agenteschat/client/lib/usage-pause";
import {
  usageQueueFacts,
  usageQueueLine,
  usageQueueMeta,
  usageQueueShared,
  usageQueueState,
  usageQueueTitle,
  usageQueueWhere,
} from "@agenteschat/client/lib/usage-queue";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button, Text } from "@/ui";
import { AnswerAnywayButton } from "../ai/UsagePauseCard";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118), the web's dialog as a sheet: what it picks up
 * when the limit is back, in this order, what happened in each since, "Don't run it" per row and "Don't run any" for
 * its owner and admins. Opened from its profile's out-of-office line and from its waiting note.
 */
export function UsageQueueSheet({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId() ?? "";
  const dir = useDirectory();
  const c = useColors();
  const now = useNow(60_000);
  const q = useUsageQueue(orgId, agentId);
  const agent = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  if (!q.data) return <ActivityIndicator style={styles.loading} />;
  const queue = q.data;
  if (queue.rows.length === 0 && queue.hidden === 0)
    return (
      <>
        <SheetTitle title={agent} />
        {queue.closed.length === 0 ? (
          <Text variant="small" tone="muted">
            {t("usageQueue.empty")}
          </Text>
        ) : (
          <SkippedRows rows={queue.closed} agentId={agentId} agent={agent} now={now} />
        )}
      </>
    );
  const person = (id: string) =>
    id === meId ? t("common.you") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  const shared = usageQueueShared(
    t,
    agent,
    queue.sharedWith.flatMap((id) => dir.anyAgent(id)?.name ?? []),
  );
  const queued = queue.rows.filter((r) => r.state === "queued").length;
  return (
    <>
      <SheetTitle
        title={usageQueueTitle(t, agent, queue)}
        subtitle={usageQueueLine(t, i18n.language, queue, new Date(now))}
      />
      {shared ? (
        <Text variant="footnote" tone="muted">
          {shared}
        </Text>
      ) : null}
      <View style={styles.rows}>
        {queue.rows.map((row) => (
          <View
            key={row.runId}
            style={[styles.row, row.askers.includes(meId) && { backgroundColor: c.sunken }]}
            accessible
            accessibilityLabel={[
              usageQueueWhere(t, row, meId, person),
              usageQueueState(t, row),
              usageQueueMeta(t, i18n.language, row, person, new Date(now)),
              usageQueueFacts(t, row),
            ].join(", ")}
          >
            <AgentFace agentId={agentId} size={20} live={row.state === "answering"} />
            <View style={styles.text}>
              <View style={styles.l1}>
                <Text variant="small" tone="ink" numberOfLines={1} style={styles.name}>
                  {usageQueueWhere(t, row, meId, person)}
                </Text>
                <Text
                  variant="caption"
                  tone={row.state === "answering" ? "ink2" : "faint"}
                  numberOfLines={1}
                  style={styles.time}
                >
                  {usageQueueState(t, row)}
                </Text>
              </View>
              <Text variant="footnote" tone="muted">
                {usageQueueMeta(t, i18n.language, row, person, new Date(now))}
              </Text>
              <Text variant="footnote" tone="muted">
                {usageQueueFacts(t, row)}
              </Text>
              {row.state === "queued" ? <RowStop row={row} /> : null}
            </View>
          </View>
        ))}
      </View>
      {queue.hidden > 0 ? (
        <Text variant="caption" tone="faint">
          {t("usageQueue.hidden", { count: queue.hidden })}
        </Text>
      ) : null}
      {queue.mayStopAll && queued > 0 ? <StopAll agentId={agentId} count={queued + queue.hidden} /> : null}
      {queue.closed.length > 0 ? <SkippedRows rows={queue.closed} agentId={agentId} agent={agent} now={now} /> : null}
    </>
  );
}

/** What it skipped in the last day as already handled (ADR 0136): why, "Responder mesmo assim" and "Ver conversa". */
function SkippedRows({
  rows,
  agentId,
  agent,
  now,
}: {
  rows: UsageQueueClosedRow[];
  agentId: string;
  agent: string;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const meId = useMeId() ?? "";
  const c = useColors();
  return (
    <View style={styles.skipped}>
      <Text variant="small" tone="ink" style={styles.name}>
        {t("usageQueue.closedTitle", { count: rows.length })}
      </Text>
      <Text variant="footnote" tone="muted">
        {t("usageQueue.closedLine", { agent })}
      </Text>
      <View style={styles.rows}>
        {rows.map((row) => {
          const where =
            row.channelKind === "dm"
              ? t("usageQueue.yourDm")
              : row.threadId
                ? t("usageQueue.thread", { channel: row.channelName ?? "" })
                : `#${row.channelName ?? ""}`;
          return (
            <View
              key={row.runId}
              style={[styles.row, row.closed.askers.includes(meId) && { backgroundColor: c.sunken }]}
            >
              <AgentFace agentId={agentId} size={20} />
              <View style={styles.text}>
                <View style={styles.l1}>
                  <Text variant="small" tone="ink" numberOfLines={1} style={styles.name}>
                    {where}
                  </Text>
                  <Text variant="caption" tone="faint" numberOfLines={1} style={styles.time}>
                    {relativeTime(t, i18n.language, row.closed.at, new Date(now))}
                  </Text>
                </View>
                <Text variant="footnote" tone="muted">
                  {closedNoteText(t, row.closed)}
                </Text>
                {row.continuedRunId ? (
                  <Text variant="footnote" tone="muted">
                    {t("usageQueue.answeredAnyway")}
                  </Text>
                ) : null}
                <View style={styles.skipActs}>
                  {row.mayAnswer ? (
                    <AnswerAnywayButton runId={row.runId} agentId={agentId} closed={row.closed} />
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="chat"
                    label={t("usageQueue.seeConversation")}
                    onPress={() => router.push(chatHref(row.channelId, row.threadId, row.messageId))}
                  />
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function RowStop({ row }: { row: UsageQueueRow }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  return (
    <View style={styles.stop}>
      <Button
        variant="secondary"
        size="sm"
        icon="stop"
        label={t("usageCard.dontRun")}
        disabled={pending || !row.mayStop}
        onPress={() => {
          setPending(true);
          api.agents
            .cancelRun(orgId, row.runId)
            .catch(failed)
            .finally(() => setPending(false));
        }}
      />
      {!row.mayStop ? (
        <Text variant="footnote" tone="faint">
          {t("usageCard.dontRunForbidden")}
        </Text>
      ) : null}
    </View>
  );
}

/** "Don't run any", asked once in place. */
function StopAll({ agentId, count }: { agentId: string; count: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const failed = useFailed();
  const stop = useCancelUsageQueue(orgId, agentId);
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button variant="secondary" icon="stop" label={t("usageQueue.dontRunAll")} onPress={() => setAsking(true)} />
    );
  return (
    <View style={styles.confirm}>
      <Text variant="small" tone="ink" style={styles.name}>
        {t("usageQueue.confirmAll", { count })}
      </Text>
      <View style={styles.confirmActs}>
        <Button variant="secondary" size="sm" label={t("usageQueue.keep")} onPress={() => setAsking(false)} />
        <Button
          variant="primary"
          size="sm"
          label={t("usageQueue.yesDontRun")}
          disabled={stop.isPending}
          onPress={() => stop.mutate(undefined, { onSuccess: () => setAsking(false), onError: failed })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 24 },
  // The rows' 8 of padding bleeds past the sheet's edge: faces line up with the title.
  rows: { marginHorizontal: -8, gap: 2 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 8, borderRadius: 12 },
  text: { flex: 1, minWidth: 0 },
  l1: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20 },
  name: { fontWeight: "600", flexShrink: 1 },
  time: { marginLeft: "auto", paddingLeft: 8, flexShrink: 0 },
  stop: { alignItems: "flex-start", gap: 4, marginTop: 6 },
  confirm: { gap: 8 },
  skipped: { gap: 4, marginTop: 12 },
  skipActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 },
  confirmActs: { flexDirection: "row", gap: 8 },
});
