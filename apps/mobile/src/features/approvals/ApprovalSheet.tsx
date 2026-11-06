import { useApproval, useChannels, useDecideApproval } from "@agenteschat/client";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import {
  aheadEndLine,
  alwaysRoutineName,
  approvalWaitsFor,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { nextLabel } from "@agenteschat/client/lib/format";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button, HoldButton, Locked, SheetScreen, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { approvalAction, approvalRisk, approveAlwaysToast } from "./logic";
import {
  ApprovalAheadLine,
  ApprovalDetails,
  ApprovalEmailLetter,
  ApprovalFuse,
  ApprovalSaid,
  ApprovalTraits,
  ApproveAlways,
  approvalTitleText,
  useCancelAhead,
  useOriginShort,
} from "./parts";

/**
 * A request, from anywhere (deep link `approval/<id>`): who asks, the action
 * in words, the action itself (the whole email, else the detail and every value, whole), what the agent said, what it affects and the amber fuse. High risk
 * takes a hold; refusing can say why ("ajuda o agente a aprender").
 */
export function ApprovalSheet({
  id,
  refuse: startRefusing = false,
  onClose,
}: {
  id: string;
  refuse?: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const now = useNow();
  const toast = useToast();
  const approval = useApproval(orgId, id);
  const channels = useChannels(orgId);
  const decide = useDecideApproval(orgId);
  const cancelAhead = useCancelAhead();
  const [refusing, setRefusing] = useState(startRefusing);
  const [reason, setReason] = useState("");
  const a = approval.data;
  const agent = a ? dir.agentById.get(a.agentId) : undefined;
  const name = agent?.name ?? "";
  const g = genderOf(name);
  const channel = a ? channels.data?.find((x) => x.id === a.channelId) : undefined;
  const origin = useOriginShort({ origin: a?.origin ?? null });
  const runAt = a?.runAt ? nextLabel(i18n.language, a.runAt) : null;

  /** `always`: "Aprovar sempre", this one and the agent's next ones of its kind. */
  const done = (decision: "approve" | "refuse", always = false) => {
    if (!a) return;
    decide.mutate(
      {
        id: a.id,
        decision,
        ...(always ? { always } : {}),
        ...(decision === "refuse" && reason.trim() ? { reason: reason.trim() } : {}),
      },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            ...(always
              ? approveAlwaysToast(t, name, alwaysRoutineName(t, a))
              : {
                  title: decision === "approve" ? t("mobile.approval.approved") : t("mobile.approval.refused"),
                  subtitle:
                    decision === "approve"
                      ? runAt
                        ? t("mobile.approval.approvedAhead", { when: runAt })
                        : t(`mobile.approval.approvedSub${g}`, { name })
                      : t(`mobile.approval.refusedSub${g}`, { name }),
                }),
            agentId: a.agentId,
          });
          onClose();
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };

  let body: ReactNode;
  if (!a) {
    body = approval.isError ? (
      <Text tone="muted">{t("mobile.approval.notFound")}</Text>
    ) : (
      <ActivityIndicator color={c.muted} />
    );
  } else {
    const pending = a.status === "pending" && new Date(a.expiresAt).getTime() > now;
    const high = approvalRisk(a) === "high";
    const owner = approvalWaitsFor(a, a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined);
    const requester = requesterDecidesLine(t, a);
    body = (
      <>
        <View style={styles.who}>
          <AgentFace agentId={a.agentId} size={40} />
          <View style={styles.grow}>
            <Text variant="body" style={styles.bold}>
              {name}
            </Text>
            <Text variant="small" tone="muted">
              {refusing
                ? t("mobile.approval.refuseTitle")
                : channel
                  ? t("mobile.approval.asksIn", { channel: channel.name })
                  : t("mobile.approval.asksYou")}
              {!refusing && origin ? ` · ${origin}` : ""}
            </Text>
          </View>
        </View>
        <Text variant="title2">{approvalTitleText(t, a)}</Text>
        {refusing ? null : <ApprovalAheadLine approval={a} />}
        {refusing ? (
          <>
            <Locked when={decide.isPending}>
              <TextArea
                value={reason}
                onChangeText={setReason}
                placeholder={t(`mobile.approval.whyPlaceholder${g}`, { name })}
                accessibilityLabel={t(`mobile.approval.whyPlaceholder${g}`, { name })}
                autoFocus
              />
            </Locked>
            <View style={styles.acts}>
              <Button
                variant="primary"
                wide
                label={t("mobile.approval.refuse")}
                loading={decide.isPending}
                onPress={() => done("refuse")}
              />
              <Button
                variant="ghost"
                wide
                label={t("mobile.common.back")}
                disabled={decide.isPending}
                onPress={() => setRefusing(false)}
              />
            </View>
          </>
        ) : (
          <>
            {a.email ? (
              <ApprovalEmailLetter email={a.email} full />
            ) : (
              <>
                {/* A connector's detail is its raw call (`tool · key=value`); its values are in the table, in words. */}
                {a.detail && !a.connector ? (
                  <Text variant="body" tone="ink2" style={styles.detail}>
                    {a.detail}
                  </Text>
                ) : null}
                <ApprovalDetails approval={a} max={Number.POSITIVE_INFINITY} long />
              </>
            )}
            <ApprovalSaid approval={a} name={name} />
            {requester ? (
              <Text variant="small" tone="muted">
                {requester}
              </Text>
            ) : null}
            <ApprovalTraits approval={a} />
            {pending ? (
              <>
                <ApprovalFuse approval={a} />
                {a.canDecide ? (
                  <>
                    <View style={styles.acts}>
                      {high ? (
                        <HoldButton
                          label={t("mobile.approval.hold")}
                          holdLabel={t("mobile.approval.holding")}
                          disabled={decide.isPending}
                          onConfirm={() => done("approve")}
                        />
                      ) : (
                        <Button
                          variant="primary"
                          wide
                          icon="check"
                          label={
                            approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")
                          }
                          loading={decide.isPending}
                          onPress={() => done("approve")}
                        />
                      )}
                      <Button
                        variant="secondary"
                        wide
                        label={t("mobile.approval.refuse")}
                        disabled={decide.isPending}
                        onPress={() => setRefusing(true)}
                      />
                      <ApproveAlways
                        approval={a}
                        name={name}
                        disabled={decide.isPending}
                        onPress={() => done("approve", true)}
                      />
                    </View>
                    <Text variant="caption" tone="faint" style={styles.note}>
                      {high
                        ? t("mobile.approval.holdNote")
                        : runAt
                          ? t("mobile.approval.tapNoteAhead", { when: runAt })
                          : t("mobile.approval.tapNote")}
                    </Text>
                  </>
                ) : (
                  <Text variant="small" tone="muted" style={styles.note}>
                    {owner ? t("mobile.approval.onlyOwner", { name: owner }) : t("mobile.approval.onlyAdmins")}
                  </Text>
                )}
              </>
            ) : aheadPhase(a) === "scheduled" && runAt ? (
              <>
                <Text variant="small" tone="muted" style={styles.note}>
                  {t("mobile.approval.status.scheduled", { when: runAt })}
                </Text>
                {a.canCancel ? (
                  <Button
                    variant="secondary"
                    wide
                    icon="x"
                    label={t("approval.ahead.cancel")}
                    loading={cancelAhead.pending}
                    onPress={() => cancelAhead.cancel(a.id, onClose)}
                  />
                ) : null}
              </>
            ) : (
              <Text variant="small" tone="muted" style={styles.note}>
                {aheadEndLine(t, a) ?? t(`mobile.approval.status.${a.status === "pending" ? "expired" : a.status}`)}
              </Text>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <SheetScreen>
      <View style={styles.in}>{body}</View>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  in: { gap: 12 },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  detail: { marginTop: -2 },
  acts: { gap: 8 },
  note: { textAlign: "center" },
});
