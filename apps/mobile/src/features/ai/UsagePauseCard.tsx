import { type CatchUpClosed, keys, type Message, useApi } from "@agenteschat/client";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  answerAnywayOpen,
  mayAnswerAnyway,
  mayContinueUsage,
  usagePauseCardOf,
  usagePauseText,
  usageWaitOf,
} from "@agenteschat/client/lib/usage-pause";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text, useTheme } from "@/ui";
import { UsageQueueSheet } from "../queue/UsageQueueSheet";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";
import { useSheetIfAny } from "../shared/SheetHost";

/**
 * "Don't run it" on what waits for a plan's or budget's limit (the web's): cancels the run, so nothing runs when the
 * limit is back. Words only (a ghost button): put it in `textActs`. Greyed for anyone but the person behind it, the
 * agent's owner and admins; the agent's status and its queue follow.
 */
export function DontRunButton({ runId, may, count = 1 }: { runId: string | null; may: boolean; count?: number }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  if (!runId) return null;
  const go = async () => {
    setPending(true);
    try {
      await api.agents.cancelRun(orgId, runId);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
      void qc.invalidateQueries({ queryKey: keys.agentStatus(orgId) });
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      label={count > 1 ? t("usageCard.dontRunThese", { count }) : t("usageCard.dontRun")}
      loading={pending}
      disabled={!may}
      onPress={() => void go()}
    />
  );
}

/**
 * "Responder mesmo assim" on a catch-up skipped as already handled (ADR 0136, the web's): the agent answers now. Anyone
 * who asked in it, the agent's owner and admins, for a week; anyone else sees it greyed. Words only, like Não rodar.
 */
export function AnswerAnywayButton({
  runId,
  agentId,
  closed,
}: {
  runId: string;
  agentId: string | null;
  closed: CatchUpClosed;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  if (!answerAnywayOpen(closed)) return null;
  const owner = dir.agentById.get(agentId ?? "")?.ownerUserId;
  const may = mayAnswerAnyway(closed, meId, owner, can(org, "manage_agents"));
  return (
    <Button
      variant="ghost"
      size="sm"
      label={t("usageCard.answerAnyway")}
      loading={pending}
      disabled={!may}
      onPress={() => {
        setPending(true);
        api.agents
          .continueRun(orgId, runId)
          .catch(failed)
          .finally(() => {
            setPending(false);
            void qc.invalidateQueries({ queryKey: keys.agentStatus(orgId) });
          });
      }}
    />
  );
}

/**
 * Under an agent's "I'll answer when the plan resets" (the web's): "Don't run it" while the run still waits; once the
 * catch-up was skipped as already handled, "Responder mesmo assim" until someone presses it.
 */
export function UsageWaitCancel({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const sheet = useSheetIfAny();
  const { org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const wait = m.author.type === "agent" ? usageWaitOf(m.meta) : null;
  const skipped = wait?.closed && !wait.continuedByUserId ? wait.closed : null;
  if (!wait || (!skipped && (wait.canceled || wait.ended))) return null;
  const owner = dir.agentById.get(m.author.id ?? "")?.ownerUserId;
  const admin = can(org, "manage_agents");
  const mayStop = mayContinueUsage(wait, meId, owner, admin);
  // Who may press it, under the row, for anyone it is greyed for.
  const forbidden = skipped
    ? answerAnywayOpen(skipped) && !mayAnswerAnyway(skipped, meId, owner, admin)
      ? "usageCard.answerAnywayForbidden"
      : null
    : wait.runId && !mayStop
      ? "usageCard.dontRunForbidden"
      : null;
  return (
    <View style={styles.acts}>
      <View style={styles.textActs}>
        {skipped ? (
          <AnswerAnywayButton runId={wait.runId} agentId={m.author.id ?? null} closed={skipped} />
        ) : (
          <DontRunButton runId={wait.runId} may={mayStop} count={wait.count} />
        )}
        {m.author.id && sheet ? (
          <Button
            variant="ghost"
            size="sm"
            label={t("queue.see")}
            onPress={() => sheet.open(<UsageQueueSheet agentId={m.author.id ?? ""} />)}
          />
        ) : null}
      </View>
      {forbidden ? (
        <Text variant="footnote" tone="faint">
          {t(forbidden)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The web's card of long work paused near its plan's or budget's limit (ADR 0118), in place of its text: when it
 * picks up by itself, and Continuar agora for the person behind the work, the agent's owner and admins (anyone else
 * sees it greyed, with who may press it).
 */
export function UsagePauseCard({ message: m }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const card = usagePauseCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const { title, line } = usagePauseText(t, i18n.language, card, name);
  const may = mayContinueUsage(card, meId, agent?.ownerUserId, can(org, "manage_agents"));
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const go = async () => {
    setPending(true);
    try {
      await api.chat.answerNow(orgId, m.id);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  };
  const done = card.state !== "paused";
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.row}>
        <Icon name={done ? "check" : "pause"} size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {title}
        </Text>
      </View>
      {card.state === "continued" && by ? (
        <Text variant="footnote" tone="faint">
          {by === meId
            ? t("stretchCard.continuedByYou", { time })
            : t("stretchCard.continued", { name: dir.memberById.get(by)?.name ?? t("channel.unknownPerson"), time })}
        </Text>
      ) : card.state === "resumed" || card.state === "ended" || card.state === "canceled" ? (
        <Text variant="footnote" tone="faint">
          {t(`usageCard.${card.state}`, { agent: name })}
        </Text>
      ) : (
        <>
          <Text variant="footnote" tone="faint">
            {line}
          </Text>
          <Button
            variant="primary"
            size="sm"
            label={t("usageCard.continue")}
            disabled={pending || !may}
            onPress={() => void go()}
          />
          <View style={styles.textActs}>
            <DontRunButton runId={card.runId} may={may} />
          </View>
          {!may ? (
            <Text variant="footnote" tone="faint">
              {t("usageCard.forbidden")}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
  acts: { marginTop: 4, gap: 2, alignItems: "flex-start" },
  // Words-only actions: the ghost buttons' own side padding hangs outside, so their words line up with the text.
  textActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginLeft: -14 },
});
