import type { ApprovalCoverInput, RightHandApprovals, RightHandApprovalsInput } from "@agenteschat/client";
import {
  useApprovalCovers,
  useDeclineApprovalCover,
  useRightHandApprovals,
  useSetApprovalCover,
  useSetRightHandApprovals,
} from "@agenteschat/client";
import { coveringLine } from "@agenteschat/client/lib/approval-words";
import { endOfDay, formatShortDate, toYmd } from "@agenteschat/client/lib/format";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { DUE_CHOICES, dueDateOf } from "../issues/logic";
import { usePersonalView } from "../settings/hooks";
import { Face } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { TextArea } from "../shared/TextArea";
import { Page } from "./parts";

/**
 * Perfil › Aprovações (ADR 0139), the web's Configurações › Você › Aprovações: who approves for me (one person or
 * no one), when (only while my status says out, or always), until when and whether risky actions are in, each saved
 * as it is tapped; then whom I approve for, each with Não quero cobrir. In a personal workspace it is listed in
 * Settings › Advanced (ADR 0159 §3), and alone there the cover part waits until someone joins or one is set.
 */
export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const meId = useMeId() ?? "";
  const dir = useDirectory();
  const covers = useApprovalCovers(orgId);
  const rightHand = useRightHandApprovals(orgId).data;
  const set = useSetApprovalCover(orgId, meId);
  const decline = useDeclineApprovalCover(orgId);
  const failed = () => toast({ title: t("approvalCover.failed"), icon: "x" });
  const cover = covers.data?.cover ?? null;
  const { solo } = usePersonalView();
  const save = (patch: Partial<ApprovalCoverInput>) => {
    const next = {
      mode: cover?.mode ?? "while_out",
      risky: cover?.risky ?? false,
      endsAt: cover?.endsAt ?? null,
      userId: cover?.userId ?? "",
      ...patch,
    };
    set.mutate(next.userId ? next : null, { onError: failed });
  };
  const people = [...dir.memberById.values()].filter((m) => m.userId !== meId);
  const endDay = cover?.endsAt ? toYmd(new Date(cover.endsAt)) : null;
  const days = DUE_CHOICES.filter((c) => c !== "none").map((c) => ({ choice: c, day: dueDateOf(c) as string }));
  return (
    <Page title={t("settings.section.approvals")}>
      {/* Alone in a personal workspace there is no one to approve for you (ADR 0159): only the right hand's part,
          unless a cover is already set, which always shows. */}
      {solo && !cover ? null : (
        <>
          <GroupedHeader>{t("approvalCover.title")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={t("approvalCover.nobody")}
              checked={!cover}
              onPress={() => cover && save({ userId: "" })}
            />
            {people.map((m) => (
              <GroupedRow
                key={m.userId}
                leading={<Face who={{ type: "person", id: m.userId }} size={28} />}
                label={m.name}
                checked={cover?.userId === m.userId}
                onPress={() => save({ userId: m.userId })}
              />
            ))}
          </GroupedList>
          <GroupedFooter>{t("approvalCover.subtitle")}</GroupedFooter>
          {cover ? (
            <>
              <GroupedHeader
                hint={{
                  name: t("common.about", { label: t("approvalCover.when") }),
                  text: t("approvalCover.whenHelp"),
                }}
              >
                {t("approvalCover.when")}
              </GroupedHeader>
              <GroupedList>
                <GroupedRow
                  label={t("approvalCover.whileOut")}
                  checked={cover.mode === "while_out"}
                  onPress={() => save({ mode: "while_out" })}
                />
                <GroupedRow
                  label={t("approvalCover.always")}
                  checked={cover.mode === "always"}
                  onPress={() => save({ mode: "always" })}
                />
              </GroupedList>
              <GroupedHeader>{t("approvalCover.until")}</GroupedHeader>
              <GroupedList>
                <GroupedRow
                  label={t("approvalCover.noDate")}
                  checked={!endDay}
                  onPress={() => save({ endsAt: null })}
                />
                {days.map(({ choice, day }) => (
                  <GroupedRow
                    key={choice}
                    label={t(`mobile.issues.form.dueChoice.${choice}`)}
                    value={formatShortDate(i18n.language, endOfDay(day))}
                    checked={endDay === day}
                    onPress={() => save({ endsAt: endOfDay(day) })}
                  />
                ))}
                {endDay && !days.some((d) => d.day === endDay) ? (
                  <GroupedRow label={formatShortDate(i18n.language, cover.endsAt as string)} checked />
                ) : null}
              </GroupedList>
              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow
                  label={t("approvalCover.risky")}
                  labelLines={2}
                  sub={t(cover.risky ? "approvalCover.riskyOn" : "approvalCover.riskyOff")}
                  subLines={2}
                  toggle={cover.risky}
                  onPress={() => save({ risky: !cover.risky })}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      )}
      {rightHand?.rightHand ? <RightHandGroup view={rightHand} name={rightHand.rightHand.name} /> : null}
      <GroupedFooter>{t("approvalCover.lock")}</GroupedFooter>
      {(covers.data?.covering ?? []).length > 0 ? (
        <>
          <GroupedHeader>{t("approvalCover.coveringTitle")}</GroupedHeader>
          {covers.data?.covering.map((c) => (
            <View key={c.userId} style={styles.covering}>
              <GroupedList>
                <GroupedRow
                  leading={<Face who={{ type: "person", id: c.userId }} size={28} />}
                  label={dir.memberById.get(c.userId)?.name ?? ""}
                  sub={coveringLine(t, i18n.language, c)}
                />
                <GroupedRow
                  label={t("approvalCover.decline")}
                  danger
                  disabled={decline.isPending}
                  onPress={() => decline.mutate(c.userId, { onError: failed })}
                />
              </GroupedList>
            </View>
          ))}
          <GroupedFooter>{t("approvalCover.coveringSubtitle")}</GroupedFooter>
        </>
      ) : null}
    </Page>
  );
}

const USD = 1_000_000_000;
/** The budgets offered per agent (the web takes any amount up to US$ 50). */
const BUDGETS = [5, 10, 20, 50];

/**
 * "O Gerente aprova por você" (ADR 0139 §2), under the workspace's name for its right hand: the switch, the two kinds
 * (greyed when the person can't decide them), the budget per agent and their own guidance, saved as they change.
 */
function RightHandGroup({ view, name }: { view: RightHandApprovals; name: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const set = useSetRightHandApprovals(orgId);
  const [guidance, setGuidance] = useState<string | null>(null);
  const save = (patch: RightHandApprovalsInput) =>
    set.mutate(patch, { onError: () => toast({ title: t("approvalCover.failed"), icon: "x" }) });
  const on = view.enabled && !view.pausedAt;
  const budget = Math.round(view.budgetCapNanoUsd / USD);
  return (
    <>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("rightHandApprovals.title", { name })}
          labelLines={2}
          sub={t(view.pausedAt ? "rightHandApprovals.paused" : "rightHandApprovals.subtitle")}
          subLines={3}
          toggle={on}
          onPress={() => save({ enabled: !on })}
        />
        {on ? (
          <>
            <GroupedRow
              label={t("rightHandApprovals.newAgents")}
              labelLines={2}
              sub={t(view.mayDecide.newAgents ? "rightHandApprovals.newAgentsHelp" : "rightHandApprovals.cantDecide")}
              subLines={2}
              toggle={view.newAgents && view.mayDecide.newAgents}
              disabled={!view.mayDecide.newAgents}
              onPress={() => save({ newAgents: !view.newAgents })}
            />
            <GroupedRow
              label={t("rightHandApprovals.agentChanges")}
              labelLines={2}
              sub={t(
                view.mayDecide.agentChanges ? "rightHandApprovals.agentChangesHelp" : "rightHandApprovals.cantDecide",
              )}
              subLines={2}
              toggle={view.agentChanges && view.mayDecide.agentChanges}
              disabled={!view.mayDecide.agentChanges}
              onPress={() => save({ agentChanges: !view.agentChanges })}
            />
          </>
        ) : null}
      </GroupedList>
      {on ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("rightHandApprovals.budget") }),
              text: t("rightHandApprovals.budgetHelp"),
            }}
          >
            {t("rightHandApprovals.budget")}
          </GroupedHeader>
          <GroupedList>
            {[...new Set([...BUDGETS, budget])]
              .sort((a, b) => a - b)
              .map((usd) => (
                <GroupedRow
                  key={usd}
                  label={`US$ ${usd}${t("rightHandApprovals.perMonth")}`}
                  checked={usd === budget}
                  onPress={() => save({ budgetCapNanoUsd: usd * USD })}
                />
              ))}
          </GroupedList>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("rightHandApprovals.guidanceLabel", { name }) }),
              text: t("rightHandApprovals.guidanceHelp", { name }),
            }}
          >
            {t("rightHandApprovals.guidanceLabel", { name })}
          </GroupedHeader>
          <TextArea
            value={guidance ?? view.guidance}
            onChangeText={setGuidance}
            onBlur={() => {
              if (guidance !== null && guidance.trim() !== view.guidance) save({ guidance: guidance.trim() });
              setGuidance(null);
            }}
            maxLength={2000}
            minHeight={64}
            placeholder={t("rightHandApprovals.guidancePlaceholder")}
            accessibilityLabel={t("rightHandApprovals.guidanceLabel", { name })}
          />
          <View style={styles.gap} />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  gap: { height: 16 },
  covering: { marginBottom: 12 },
});
