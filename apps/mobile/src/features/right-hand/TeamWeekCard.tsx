import {
  keys,
  type Message,
  type Proposal,
  useActOnTeamWeek,
  useAgentActions,
  useApprovals,
  useCardProposals,
  useChannels,
  useDecideProposal,
  useTeamWeekPrefs,
} from "@agenteschat/client";
import { clockAt, formatUsd, joinNames } from "@agenteschat/client/lib/format";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  appliesInBulk,
  type TeamWeekCard,
  type TeamWeekNames,
  type TeamWeekRow,
  teamWeekCardOf,
  teamWeekDoneText,
  teamWeekRowMessage,
  teamWeekRowState,
  teamWeekRowText,
  teamWeekWhen,
} from "@agenteschat/client/lib/team-week";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text } from "@/ui";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { openRightHandSettings } from "./SettingsScreen";

const NANO = 1_000_000_000;

/**
 * Lodi's weekly card (ADR 0137 §9), as on the web: the four numbers two by two, what worked, then each fix stacked
 * with its button under its words, applied as whoever taps; "Aplicar as N", "Agora não", and the day and hour,
 * changed in Configurações › Lodi.
 */
export function TeamWeek({ message: m }: { message: Message }) {
  const card = m.author.type === "agent" ? teamWeekCardOf(m.meta) : null;
  return card ? <WeekCard message={m} card={card} /> : null;
}

function WeekCard({ message, card }: { message: Message; card: TeamWeekCard }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const channels = useChannels(orgId).data ?? [];
  const proposals = useCardProposals(orgId, card.proposalIds);
  const approvals = useApprovals(orgId);
  const decide = useDecideProposal(orgId);
  const act = useActOnTeamWeek(orgId);
  const prefs = useTeamWeekPrefs(orgId).data;
  const failed = useFailed();
  const [applying, setApplying] = useState(false);
  const locale = i18n.language;
  const names: TeamWeekNames = {
    agent: (id) => (id ? dir.anyAgent(id)?.name : undefined) ?? t("channel.unknownAgent"),
    handle: (id) => (id ? (dir.anyAgent(id)?.handle ?? null) : null),
    channel: (id) => channels.find((ch) => ch.id === id)?.name ?? "…",
    usd: (n) => formatUsd(locale, Math.round(n / NANO)),
    join: (list) => joinNames(list, t),
    since: (iso) => clockAt(locale, iso),
  };
  const rows = card.rows.map((row) => ({
    row,
    state: teamWeekRowState(card, row, { proposals, approvals: approvals.data }),
    text: teamWeekRowText(t, locale, row, names),
  }));
  const open = rows.filter((r) => r.state === "open");
  const bulk = open.filter((r) => appliesInBulk(r.row));
  const dismissed = !!card.dismissedAt;
  const lodi = dir.agents.find(isRightHand);
  const apply = async (row: TeamWeekRow) => {
    if (row.kind === "budget" || row.kind === "channel")
      await decide.mutateAsync({ id: row.proposalId, decision: "accept" });
    else if (row.kind === "approvals") {
      const next = row.approvalIds.find((id) => approvals.data?.find((a) => a.id === id)?.status === "pending");
      router.push(`/approval/${next ?? row.approvalIds[0]}` as never);
    } else
      await act.mutateAsync({ messageId: message.id, act: { rowId: row.id, text: teamWeekRowMessage(t, row, names) } });
  };
  const applyAll = async () => {
    setApplying(true);
    try {
      for (const r of bulk) await apply(r.row);
    } catch (e) {
      failed(e);
    } finally {
      setApplying(false);
    }
  };
  const { stats } = card;
  const stat = (value: string, label: string, warn = false) => (
    <View key={label} style={[styles.stat, { backgroundColor: c.sunken }]}>
      <Text variant="title" style={[styles.statValue, warn ? { color: c.amber } : null]} numberOfLines={1}>
        {value}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
  return (
    // Its week ("Como foi a semana do time, de 28 out. a 3 nov.") is the message's text, above.
    <View style={styles.wrap}>
      <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <View style={styles.head}>
          <Text variant="footnote" tone="muted" style={styles.semibold}>
            {t("teamWeek.title")}
          </Text>
          {open.length > 0 && !dismissed ? (
            <Text variant="caption" style={[styles.semibold, { color: c.amber }]}>
              {t("teamWeek.suggestions", { count: open.length })}
            </Text>
          ) : null}
        </View>
        <View style={styles.stats}>
          {stat(String(stats.done), t("teamWeek.stat.done"))}
          {stat(String(stats.stuck), t("teamWeek.stat.stuck"), stats.stuck > 0)}
          {stat(String(stats.waiting), t("teamWeek.stat.waiting"), stats.waiting > 0)}
          {stat(names.usd(stats.spentNanoUsd), t("teamWeek.stat.budget", { budget: names.usd(stats.budgetNanoUsd) }))}
        </View>
        {card.worked.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" tone="muted" style={styles.semibold}>
              {t("teamWeek.worked")}
            </Text>
            {card.worked.map((w) => (
              <View key={`${w.kind}:${w.agentId}`} style={styles.worked}>
                <Icon name="check" size={14} color={c.ok} />
                <Text variant="footnote" tone="ink" style={styles.fill}>
                  {w.kind === "runs"
                    ? t("teamWeek.workedRuns", {
                        name: names.agent(w.agentId),
                        count: w.count,
                        channel: names.channel(w.channelId),
                      })
                    : t("teamWeek.workedTasks", { name: names.agent(w.agentId), count: w.count })}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {dismissed ? (
          <Text variant="footnote" tone="muted" style={styles.section}>
            {t("teamWeek.dismissed")}
          </Text>
        ) : rows.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" tone="muted" style={styles.semibold}>
              {t("teamWeek.improve")}
            </Text>
            {rows.map(({ row, state, text }) => (
              <Fix
                key={row.id}
                message={message}
                row={row}
                state={state}
                title={text.title}
                line={text.line}
                action={text.action}
                proposal={proposals.find((p) => "proposalId" in row && p.id === row.proposalId)}
                doneText={teamWeekDoneText(t, row, lodi?.name ?? "Lodi")}
                busy={applying}
                onApply={() => apply(row).catch(failed)}
              />
            ))}
          </View>
        ) : null}
        <View style={[styles.foot, { borderTopColor: c.line }]}>
          {!dismissed && bulk.length > 0 ? (
            <Button
              variant="primary"
              wide
              label={t("teamWeek.applyAll", { count: bulk.length })}
              loading={applying}
              onPress={() => void applyAll()}
            />
          ) : null}
          {!dismissed && open.length > 0 ? (
            <Button
              variant="ghost"
              wide
              label={t("teamWeek.notNow")}
              disabled={applying}
              onPress={() => act.mutate({ messageId: message.id, act: { dismiss: true } }, { onError: failed })}
            />
          ) : null}
          {prefs ? (
            <Pressable accessibilityRole="button" onPress={openRightHandSettings} hitSlop={6} style={styles.when}>
              <Text variant="footnote" tone="muted">
                {prefs.off ? t("teamWeek.off") : teamWeekWhen(t, locale, prefs)}
                {" · "}
                <Text variant="footnote" tone="ink" style={styles.semibold}>
                  {t("teamWeek.change")}
                </Text>
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function Fix({
  message,
  row,
  state,
  title,
  line,
  action,
  proposal,
  doneText,
  busy,
  onApply,
}: {
  message: Message;
  row: TeamWeekRow;
  state: "open" | "done" | "gone";
  title: string;
  line: string;
  action: string;
  proposal: Proposal | undefined;
  doneText: string;
  busy: boolean;
  onApply: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const qc = useQueryClient();
  const failed = useFailed();
  const actions = useAgentActions(orgId, message.channelId);
  const [pending, setPending] = useState(false);
  const agentId = "agentId" in row ? row.agentId : null;
  const receipt = proposal?.undoActionId ? message.actions?.find((a) => a.id === proposal.undoActionId) : undefined;
  const undoable =
    receipt && !receipt.undoneAt && receipt.undoableUntil && Date.parse(receipt.undoableUntil) > Date.now();
  const done = state !== "open";
  return (
    <View
      style={[
        styles.fix,
        done ? { borderColor: c.line, borderWidth: StyleSheet.hairlineWidth } : { backgroundColor: c.sunken },
      ]}
    >
      <View style={styles.fixTop}>
        {agentId ? (
          <AgentFace agentId={agentId} size={32} live={false} />
        ) : (
          <View style={[styles.tile, { backgroundColor: c.raised }]}>
            <Icon name={row.kind === "unanswered" ? "help" : row.kind === "stalled" ? "issue" : "clock"} size={16} />
          </View>
        )}
        <View style={styles.fill}>
          <Text variant="small" tone={done ? "muted" : "ink"} style={styles.semibold}>
            {title}
          </Text>
          <Text variant="footnote" tone="ink2">
            {line}
          </Text>
        </View>
      </View>
      {state === "done" ? (
        <View style={styles.doneRow}>
          <Icon name="check" size={14} color={c.ok} />
          <Text variant="footnote" tone="ok" style={[styles.semibold, styles.fill]}>
            {receipt?.undoneAt ? t("rightHand.card.undone") : doneText}
          </Text>
          {undoable ? (
            <Button
              variant="ghost"
              size="sm"
              label={t("teamWeek.undo")}
              loading={actions.undo.isPending}
              onPress={() =>
                actions.undo.mutate(receipt.id, {
                  onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
                  onError: failed,
                })
              }
            />
          ) : null}
        </View>
      ) : state === "gone" ? (
        <Text variant="footnote" tone="muted">
          {t("teamWeek.gone")}
        </Text>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          wide
          label={action}
          loading={pending}
          disabled={busy}
          onPress={() => {
            setPending(true);
            void onApply().finally(() => setPending(false));
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  card: {
    paddingTop: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  semibold: { fontWeight: "600" },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  stat: { flexBasis: "47%", flexGrow: 1, padding: 10, borderRadius: 12, borderBottomLeftRadius: 4, gap: 2 },
  statValue: { fontVariant: ["tabular-nums"] },
  section: { marginTop: 16, gap: 8 },
  worked: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  fix: { padding: 12, borderRadius: 12, borderBottomLeftRadius: 4, gap: 10 },
  fixTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tile: {
    width: 32,
    height: 32,
    borderRadius: 9,
    borderBottomLeftRadius: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  foot: {
    marginTop: 14,
    marginHorizontal: -14,
    paddingTop: 12,
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  when: { alignSelf: "flex-start", minHeight: 28, justifyContent: "center" },
});
