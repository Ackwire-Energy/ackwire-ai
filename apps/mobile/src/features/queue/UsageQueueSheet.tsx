import { type UsageQueueClosedRow, type UsageQueueRow, useCancelUsageQueue, useUsageQueue } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
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
import { openAgentAi } from "../ai/AgentAiScreen";
import { AnswerAnywayButton, DontRunButton } from "../ai/UsagePauseCard";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheetIfAny } from "../shared/SheetHost";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118), the web's dialog as a sheet: what it picks up
 * when the limit is back, in this order, what happened in each since, "Don't run it" per row, "Don't run any" and
 * "Change its AI" for its owner and admins, then what it skipped as already handled. Opened from its profile's
 * out-of-office line, its waiting note and its owner's notice.
 */
export function UsageQueueSheet({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId() ?? "";
  const dir = useDirectory();
  const c = useColors();
  const sheet = useSheetIfAny();
  const now = useNow(60_000);
  const q = useUsageQueue(orgId, agentId);
  const agent = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  if (!q.data)
    return q.isError ? (
      <View style={styles.failed}>
        <Text variant="small" tone="muted">
          {t("mobile.app.failed")}
        </Text>
        <Button variant="secondary" size="sm" label={t("common.retry")} onPress={() => void q.refetch()} />
      </View>
    ) : (
      <ActivityIndicator color={c.muted} style={styles.loading} />
    );
  const queue = q.data;
  const waiting = queue.rows.length + queue.hidden;
  if (waiting === 0)
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
  const queued = queue.rows.filter((r) => r.state === "queued").length + queue.hidden;
  const leave = (go: () => void) => {
    sheet?.close();
    go();
  };
  return (
    <>
      <SheetTitle
        title={usageQueueTitle(t, agent, queue)}
        subtitle={usageQueueLine(t, i18n.language, queue, new Date(now))}
      />
      <View style={styles.group}>
        {queue.closed.length > 0 ? (
          <Text variant="small" tone="ink" style={styles.name}>
            {t("usageQueue.toResume")}
          </Text>
        ) : null}
        {shared ? (
          <Text variant="footnote" tone="muted">
            {shared}
          </Text>
        ) : null}
        <View style={styles.rows}>
          {queue.rows.map((row) => (
            <WaitingRow key={row.runId} row={row} agentId={agentId} person={person} now={now} onLeave={leave} />
          ))}
        </View>
        {queue.hidden > 0 ? (
          <Text variant="caption" tone="faint">
            {t("usageQueue.hidden", { count: queue.hidden })}
          </Text>
        ) : null}
      </View>
      {queue.mayStopAll ? (
        <View style={styles.owner}>
          {queued > 0 ? <StopAll agentId={agentId} count={queued} /> : null}
          <View style={styles.textActs}>
            <Button
              variant="ghost"
              size="sm"
              label={t("usageQueue.switchAi", agentGrammar(agent))}
              onPress={() => leave(() => openAgentAi(agentId))}
            />
          </View>
        </View>
      ) : null}
      {queue.closed.length > 0 ? <SkippedRows rows={queue.closed} agentId={agentId} agent={agent} now={now} /> : null}
    </>
  );
}

/** One conversation in line: where, who asked and when, what happened since, Ver conversa and Não rodar. */
function WaitingRow({
  row,
  agentId,
  person,
  now,
  onLeave,
}: {
  row: UsageQueueRow;
  agentId: string;
  person: (id: string) => string;
  now: number;
  onLeave: (go: () => void) => void;
}) {
  const { t, i18n } = useTranslation();
  const meId = useMeId() ?? "";
  const dir = useDirectory();
  const c = useColors();
  const where = usageQueueWhere(t, row, meId, person);
  const state = usageQueueState(t, row);
  const meta = usageQueueMeta(t, i18n.language, row, person, new Date(now));
  const facts = usageQueueFacts(t, row, dir.memberById.get(meId)?.name);
  return (
    <View style={[styles.row, row.askers.includes(meId) && { backgroundColor: c.sunken }]}>
      <RowFace agentId={agentId} askers={row.askers} answering={row.state === "answering"} />
      <View style={styles.text}>
        <View style={styles.l1} accessible accessibilityLabel={[where, state, meta, facts].join(", ")}>
          <Text variant="small" tone="ink" style={styles.name}>
            {where}
          </Text>
          <Text variant="caption" tone={row.state === "answering" ? "ink2" : "faint"} style={styles.time}>
            {state}
          </Text>
        </View>
        <Text variant="footnote" tone="muted">
          {meta}
        </Text>
        <Text variant="footnote" tone="muted">
          {facts}
        </Text>
        <View style={styles.textActs}>
          {row.state === "queued" && row.mayStop ? <DontRunButton runId={row.runId} may /> : null}
          <Button
            variant="ghost"
            size="sm"
            label={t("usageQueue.seeConversation")}
            onPress={() => onLeave(() => router.push(chatHref(row.channelId, row.threadId, row.messageId)))}
          />
        </View>
      </View>
    </View>
  );
}

/** A row's face: the first person who asked (who waits on it), or the agent itself for a routine or long work. */
function RowFace({ agentId, askers, answering }: { agentId: string; askers: string[]; answering?: boolean }) {
  const asker = askers[0];
  return asker ? (
    <Face who={{ type: "person", id: asker }} size={20} live={false} />
  ) : (
    <AgentFace agentId={agentId} size={20} live={answering} />
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
  const sheet = useSheetIfAny();
  return (
    <View style={styles.skipped}>
      <Text variant="small" tone="ink" style={styles.name}>
        {t("usageQueue.closedTitle", { count: rows.length })}
      </Text>
      <Text variant="footnote" tone="muted">
        {t(rows.some((r) => r.mayAnswer && !r.continuedRunId) ? "usageQueue.closedLine" : "usageQueue.closedWhy", {
          agent,
        })}
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
              <RowFace agentId={agentId} askers={row.closed.askers} />
              <View style={styles.text}>
                <View style={styles.l1}>
                  <Text variant="small" tone="ink" style={styles.name}>
                    {where}
                  </Text>
                  <Text variant="caption" tone="faint" style={styles.time}>
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
                <View style={styles.textActs}>
                  {row.mayAnswer && !row.continuedRunId ? (
                    <AnswerAnywayButton runId={row.runId} agentId={agentId} closed={row.closed} />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    label={t("usageQueue.seeConversation")}
                    onPress={() => {
                      sheet?.close();
                      router.push(chatHref(row.channelId, row.threadId, row.messageId));
                    }}
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

/** "Don't run any", asked once in place. */
function StopAll({ agentId, count }: { agentId: string; count: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const failed = useFailed();
  const stop = useCancelUsageQueue(orgId, agentId);
  const [asking, setAsking] = useState(false);
  if (!asking)
    return <Button variant="secondary" size="sm" label={t("usageQueue.dontRunAll")} onPress={() => setAsking(true)} />;
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
          loading={stop.isPending}
          onPress={() => stop.mutate(undefined, { onSuccess: () => setAsking(false), onError: failed })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 24 },
  failed: { gap: 12, alignItems: "flex-start", marginVertical: 12 },
  group: { gap: 4 },
  // The rows' 8 of padding bleeds past the sheet's edge: faces line up with the title.
  rows: { marginHorizontal: -8, gap: 2 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 8, borderRadius: 12 },
  text: { flex: 1, minWidth: 0 },
  l1: { flexDirection: "row", alignItems: "flex-start", gap: 6, minHeight: 20 },
  name: { fontWeight: "600", flexShrink: 1 },
  time: { marginLeft: "auto", paddingLeft: 8, flexShrink: 0 },
  // Words-only actions: the ghost button's own side padding hangs outside, so its words line up with the text.
  textActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginLeft: -14, marginTop: 2 },
  owner: { gap: 4, marginTop: 12, alignItems: "flex-start" },
  confirm: { gap: 8 },
  skipped: { gap: 4, marginTop: 16 },
  confirmActs: { flexDirection: "row", gap: 8 },
});
