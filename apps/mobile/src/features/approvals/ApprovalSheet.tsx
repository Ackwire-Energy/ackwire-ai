import { useApproval, useChannels, useDecideApproval } from "@agenteschat/client";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button, Card, Chip, Fuse, HoldButton, SheetScreen, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId } from "../shared/hooks";
import { agentLook, fuseRemaining, genderOf, minutesLeft } from "../shared/logic";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { approvalFacts, approvalRisk, approvalTraits } from "./logic";

const TRAIT_ICON = { production: "server", irreversible: "x", reversible: "back", external: "send" } as const;

/**
 * A request, from anywhere (deep link `approval/<id>`): who asks, the exact
 * action and its values, the fuse. High risk takes a hold; refusing can say
 * why ("ajuda o agente a aprender").
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
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const now = useNow();
  const toast = useToast();
  const approval = useApproval(orgId, id);
  const channels = useChannels(orgId);
  const decide = useDecideApproval(orgId);
  const [refusing, setRefusing] = useState(startRefusing);
  const [reason, setReason] = useState("");
  const a = approval.data;
  const agent = a ? dir.agentById.get(a.agentId) : undefined;
  const name = agent?.name ?? "";
  const g = genderOf(name);
  const channel = a ? channels.data?.find((x) => x.id === a.channelId) : undefined;

  const done = (decision: "approve" | "refuse") => {
    if (!a) return;
    decide.mutate(
      { id: a.id, decision, ...(decision === "refuse" && reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: decision === "approve" ? t("mobile.approval.approved") : t("mobile.approval.refused"),
            subtitle:
              decision === "approve"
                ? t(`mobile.approval.approvedSub${g}`, { name })
                : t(`mobile.approval.refusedSub${g}`, { name }),
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
    const facts = approvalFacts(a.params);
    const owner = a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined;
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
            </Text>
          </View>
        </View>
        <Text variant="title2">{a.title}</Text>
        {refusing ? (
          <>
            <TextArea
              value={reason}
              onChangeText={setReason}
              placeholder={t(`mobile.approval.whyPlaceholder${g}`, { name })}
              accessibilityLabel={t(`mobile.approval.whyPlaceholder${g}`, { name })}
              autoFocus
            />
            <View style={styles.acts}>
              <Button
                variant="primary"
                wide
                label={t("mobile.approval.refuse")}
                disabled={decide.isPending}
                onPress={() => done("refuse")}
              />
              <Button variant="ghost" wide label={t("mobile.common.back")} onPress={() => setRefusing(false)} />
            </View>
          </>
        ) : (
          <>
            {a.detail ? (
              <Text variant="body" tone="ink2" style={styles.detail}>
                {a.detail}
              </Text>
            ) : null}
            {facts.length > 0 || a.connector ? (
              <Card>
                {a.connector ? (
                  <Fact label={t("mobile.approval.via")} value={a.connectorAccount ?? a.connector} first />
                ) : null}
                {facts.map(([k, v], i) => (
                  <Fact key={k} label={k} value={v} first={i === 0 && !a.connector} />
                ))}
              </Card>
            ) : null}
            {approvalTraits(a).length > 0 ? (
              <View style={styles.chips}>
                {approvalTraits(a).map((tr) => (
                  <Chip key={tr} icon={TRAIT_ICON[tr]} label={t(`mobile.approval.trait.${tr}`)} />
                ))}
              </View>
            ) : null}
            {a.why ? (
              <Text variant="small" tone="muted" style={styles.detail}>
                {t("mobile.approval.why", { name, text: a.why })}
              </Text>
            ) : null}
            {pending ? (
              <>
                <View style={styles.fuse}>
                  <View style={styles.grow}>
                    <Fuse color={agentLook(agent).color} remaining={fuseRemaining(a.createdAt, a.expiresAt, now)} />
                  </View>
                  <Text variant="caption" tone="faint">
                    {t("mobile.approval.expiresIn", { count: minutesLeft(a.expiresAt, now) })}
                  </Text>
                </View>
                {a.canDecide ? (
                  <>
                    <View style={styles.acts}>
                      {high ? (
                        <HoldButton
                          label={t("mobile.approval.hold")}
                          holdLabel={t("mobile.approval.holding")}
                          onConfirm={() => done("approve")}
                        />
                      ) : (
                        <Button
                          variant="primary"
                          wide
                          icon="check"
                          label={t("mobile.approval.approve")}
                          disabled={decide.isPending}
                          onPress={() => done("approve")}
                        />
                      )}
                      <Button
                        variant="secondary"
                        wide
                        label={t("mobile.approval.refuse")}
                        onPress={() => setRefusing(true)}
                      />
                    </View>
                    <Text variant="caption" tone="faint" style={styles.note}>
                      {high ? t("mobile.approval.holdNote") : t("mobile.approval.tapNote")}
                    </Text>
                  </>
                ) : (
                  <Text variant="small" tone="muted" style={styles.note}>
                    {owner ? t("mobile.approval.onlyOwner", { name: owner }) : t("mobile.approval.onlyAdmins")}
                  </Text>
                )}
              </>
            ) : (
              <Text variant="small" tone="muted" style={styles.note}>
                {t(`mobile.approval.status.${a.status === "pending" ? "expired" : a.status}`)}
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

function Fact({ label, value, first }: { label: string; value: string; first?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.kv, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}>
      <Text variant="small" tone="muted" style={styles.grow}>
        {label}
      </Text>
      <Text variant="small" tone="ink" style={[styles.bold, styles.value]} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  in: { gap: 12 },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  detail: { marginTop: -2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  fuse: { flexDirection: "row", alignItems: "center", gap: 10 },
  acts: { gap: 8 },
  note: { textAlign: "center" },
  kv: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  value: { maxWidth: "60%", textAlign: "right" },
});
